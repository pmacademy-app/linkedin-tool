/**
 * LinkedIn Comment publishing via the official Comments API.
 *
 * Endpoint:  POST /rest/socialActions/{shareUrn|ugcPostUrn}/comments
 * Docs:      https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api
 * Scope:     w_member_social (Open Permission — no review required)
 *            Granted via "Share on LinkedIn" product in the Developer Portal.
 *
 * IMPORTANT LIMITATIONS — read before using:
 *
 *  1. The API requires a post URN (e.g. urn:li:activity:123456789).
 *     We attempt to extract the activity ID from the LinkedIn post URL.
 *     This extraction works for URLs like:
 *       linkedin.com/posts/username_activityid-activity-DIGITS
 *       linkedin.com/feed/update/urn:li:activity:DIGITS
 *     If the URL format doesn't match, we fall back to manual submission.
 *
 *  2. The access token must contain w_member_social scope.
 *
 *  3. LinkedIn rate-limits comment creation (1 per minute per member).
 *
 *  4. The program never marks a comment as published unless the API returns 201.
 */
import { LINKEDIN } from "../config.js";
import { getAccessToken, getPersonUrn, isAuthorized } from "./auth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PublishCommentStatus =
  | "published"          // LinkedIn API confirmed success (HTTP 201)
  | "manual_fallback"    // Not authorized or no URN — user must do it manually
  | "publish_failed";    // API call made but failed

export interface PublishCommentResult {
  status: PublishCommentStatus;
  /** Human-readable reason for failure or fallback (safe to display) */
  reason?: string;
  /** LinkedIn comment URN returned on success */
  commentUrn?: string;
}

// ---------------------------------------------------------------------------
// URN extraction from LinkedIn URL
// ---------------------------------------------------------------------------

/**
 * Attempts to extract a LinkedIn activity URN from a post URL.
 *
 * Handles formats:
 *   /posts/username_topic-activity-6631349431612559360-xxxx
 *   /feed/update/urn:li:activity:6631349431612559360
 *   /posts/username_activityid  (where activityid is purely numeric)
 */
export function extractActivityUrnFromUrl(url: string): string | null {
  try {
    const u = new URL(url);

    // Format 1: /feed/update/urn:li:activity:DIGITS
    const feedMatch = u.pathname.match(/\/feed\/update\/(urn:li:activity:\d+)/i);
    if (feedMatch?.[1]) return feedMatch[1];

    // Format 2: -activity-DIGITS in path or query
    const activityMatch = (u.pathname + u.search).match(/-activity-(\d{15,})/);
    if (activityMatch?.[1]) return `urn:li:activity:${activityMatch[1]}`;

    // Format 3: path ends with standalone large digit (sometimes in pulse)
    const digitMatch = u.pathname.match(/(\d{15,})(?:\/|$)/);
    if (digitMatch?.[1]) return `urn:li:activity:${digitMatch[1]}`;

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Publish comment
// ---------------------------------------------------------------------------

export async function publishComment(
  postUrl: string,
  commentText: string
): Promise<PublishCommentResult> {
  // 1. Check authorization
  if (!isAuthorized()) {
    return {
      status: "manual_fallback",
      reason: "LinkedIn API authorization unavailable (access token or person URN missing).",
    };
  }

  const accessToken = getAccessToken();
  const personUrn = getPersonUrn();

  if (!accessToken || !personUrn) {
    return {
      status: "manual_fallback",
      reason: "LinkedIn access token or person URN missing. Set LINKEDIN_PERSON_URN in .env or re-authorize with --linkedin-auth.",
    };
  }

  // 2. Extract post URN from URL
  const activityUrn = extractActivityUrnFromUrl(postUrl);
  if (!activityUrn) {
    return {
      status: "manual_fallback",
      reason:
        "Cannot determine LinkedIn post URN from URL. " +
        "The URL format is not recognized for API submission. " +
        "Please paste and submit the comment manually.",
    };
  }

  // 3. Publish via official API
  const encodedUrn = encodeURIComponent(activityUrn);
  const endpoint = `https://api.linkedin.com/rest/socialActions/${encodedUrn}/comments`;

  const body = {
    actor: personUrn,
    object: activityUrn,
    message: { text: commentText },
  };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
        "LinkedIn-Version": LINKEDIN.apiVersion,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      status: "publish_failed",
      reason: `Network error calling LinkedIn API: ${String(err)}`,
    };
  }

  // 201 = success
  if (res.status === 201) {
    const commentId = res.headers.get("x-restli-id") ?? undefined;
    const commentUrn = commentId
      ? `urn:li:comment:(${activityUrn},${commentId})`
      : undefined;
    return { status: "published", commentUrn };
  }

  // Map common error codes to human-readable reasons
  const reason = await humanReadableLinkedInError(res);
  return { status: "publish_failed", reason };
}

// ---------------------------------------------------------------------------
// Error message mapping
// ---------------------------------------------------------------------------

async function humanReadableLinkedInError(res: Response): Promise<string> {
  const safeBody = await res.text().catch(() => "");
  // Trim token from any error response body just in case
  const cleanBody = safeBody.slice(0, 300).replace(/Bearer [A-Za-z0-9._-]+/g, "Bearer [REDACTED]");

  switch (res.status) {
    case 400:
      return `LinkedIn API: bad request (400). Post URN or request body may be malformed. ${cleanBody}`;
    case 401:
      return "LinkedIn API: unauthorized (401). Access token may be expired. Re-authorize with --linkedin-auth.";
    case 403:
      return (
        "LinkedIn API: forbidden (403). " +
        "Your app may lack the w_member_social permission, or the post may not allow API comments. " +
        cleanBody
      );
    case 404:
      return "LinkedIn API: post not found (404). The activity URN may be incorrect or the post was deleted.";
    case 422:
      return `LinkedIn API: unprocessable entity (422). ${cleanBody}`;
    case 429:
      return "LinkedIn API: rate limit exceeded (429). LinkedIn allows approximately 1 comment per minute. Wait and try again.";
    case 500:
    case 503:
      return `LinkedIn API: server error (${res.status}). Try again later.`;
    default:
      return `LinkedIn API returned HTTP ${res.status}. ${cleanBody}`;
  }
}