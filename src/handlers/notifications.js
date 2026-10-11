/**
 * notifications.js — 6 tool handlers.
 *
 *   - dismiss_notification
 *   - get_notification_details
 *   - list_notifications
 *   - manage_notification_subscription
 *   - manage_repository_notification_subscription
 *   - mark_all_notifications_read
 *
 * Ported from the upstream Go server:
 *   pkg/github/notifications.go                     (the six handlers)
 *   pkg/github/discussion_notification_inputs.go    (input structs / normalization)
 *   pkg/github/discussion_notification_outputs.go   (NotificationOutput + subscription output)
 */

import { defined, fail, optionalString, paginationQuery, requireString, seg } from '../util.js';

const FILTER_INCLUDE_READ = 'include_read_notifications';
const FILTER_ONLY_PARTICIPATING = 'only_participating';

const ACTION_IGNORE = 'ignore';
const ACTION_WATCH = 'watch';
const ACTION_DELETE = 'delete';

const INVALID_ACTION = 'Invalid action. Must be one of: ignore, watch, delete.';

/** `time.Parse(time.RFC3339, …)` — the only shape the upstream accepts here. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Validate an RFC3339 timestamp argument.
 * NOTE: Go embeds its full `time.Parse` diagnostic after the prefix (e.g.
 * `parsing time "x" as "2006-01-02T15:04:05Z07:00": cannot parse …`); we report
 * the rejected value instead of reproducing the parser's byte-offset wording.
 */
function parseRfc3339(value, argument) {
  if (!RFC3339.test(value) || Number.isNaN(new Date(value).getTime())) {
    fail(`invalid ${argument} time format, should be RFC3339/ISO8601: ${value}`);
  }
  return value;
}

/** `time.Time` JSON encoding — RFC3339 with trailing fractional zeros removed. */
function rfc3339(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const match = /^(.*?)(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return value;
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  return fraction.length > 0 ? `${match[1]}.${fraction}${match[3]}` : `${match[1]}${match[3]}`;
}

/** `notificationOutput`. */
function notificationOutput(thread) {
  if (!thread) return null;
  return defined({
    id: thread.id,
    repository: thread.repository
      ? defined({
          id: thread.repository.id,
          name: thread.repository.name,
          full_name: thread.repository.full_name,
          private: thread.repository.private,
          html_url: thread.repository.html_url,
        })
      : undefined,
    subject: thread.subject
      ? defined({ title: thread.subject.title, type: thread.subject.type, url: thread.subject.url })
      : undefined,
    reason: thread.reason,
    unread: thread.unread,
    updated_at: rfc3339(thread.updated_at),
    last_read_at: rfc3339(thread.last_read_at),
  });
}

/** `notificationSubscriptionOutput` — always a non-nil (possibly empty) subscription. */
function subscriptionOutput(subscription) {
  const out = {};
  if (subscription) {
    if (subscription.subscribed !== undefined) out.subscribed = subscription.subscribed;
    if (subscription.ignored !== undefined) out.ignored = subscription.ignored;
    if (subscription.reason) out.reason = subscription.reason;
    if (subscription.created_at) out.created_at = rfc3339(subscription.created_at);
  }
  return out;
}

/** `list_notifications` — GET /notifications, or the per-repository variant. */
async function listNotifications(args, ctx) {
  const filter = optionalString(args, 'filter') ?? 'default';
  const since = optionalString(args, 'since');
  const before = optionalString(args, 'before');
  const owner = optionalString(args, 'owner');
  const repo = optionalString(args, 'repo');
  const { page, per_page } = paginationQuery(args, { defaultPerPage: 30 });

  const notifications = await ctx.client.get(owner !== undefined && repo !== undefined ? `/repos/${seg(owner)}/${seg(repo)}/notifications` : '/notifications', {
    query: {
      all: filter === FILTER_INCLUDE_READ ? true : undefined,
      participating: filter === FILTER_ONLY_PARTICIPATING ? true : undefined,
      since: since === undefined ? undefined : parseRfc3339(since, 'since'),
      before: before === undefined ? undefined : parseRfc3339(before, 'before'),
      page,
      per_page,
    },
    signal: ctx.signal,
  });

  const list = Array.isArray(notifications) ? notifications : [];
  return list.map((thread) => notificationOutput(thread));
}

/** `get_notification_details` — GET /notifications/threads/{notificationID}. */
async function getNotificationDetails(args, ctx) {
  const notificationId = requireString(args, 'notificationID');
  const thread = await ctx.client.get(`/notifications/threads/${seg(notificationId)}`, { signal: ctx.signal });
  // The upstream MarshalJSON would emit `null` for an empty thread; the handler
  // contract forbids returning null, so report it as an error instead.
  if (!thread) fail('failed to get notification details: empty response');
  return notificationOutput(thread);
}

/** `dismiss_notification` — PATCH (read) or DELETE (done) /notifications/threads/{id}. */
async function dismissNotification(args, ctx) {
  const threadId = requireString(args, 'threadID');
  const state = requireString(args, 'state');
  const path = `/notifications/threads/${seg(threadId)}`;

  if (state === 'done') {
    await ctx.client.delete(path, undefined, { signal: ctx.signal });
  } else if (state === 'read') {
    // go-github's MarkThreadRead issues a PATCH for this endpoint.
    await ctx.client.patch(path, undefined, { signal: ctx.signal });
  } else {
    return fail('Invalid state. Must be one of: read, done.');
  }

  return { message: `Notification marked as ${state}` };
}

/** `mark_all_notifications_read` — PUT /notifications (or the repo variant). */
async function markAllNotificationsRead(args, ctx) {
  const lastReadAt = optionalString(args, 'lastReadAt');
  const owner = optionalString(args, 'owner');
  const repo = optionalString(args, 'repo');

  const timestamp = lastReadAt === undefined ? new Date() : new Date(parseRfc3339(lastReadAt, 'lastReadAt'));
  const body = { last_read_at: `${timestamp.toISOString().replace(/\.\d+Z$/, '')}Z` };
  const path = owner !== undefined && repo !== undefined ? `/repos/${seg(owner)}/${seg(repo)}/notifications` : '/notifications';

  await ctx.client.put(path, body, { signal: ctx.signal });
  return { message: 'All notifications marked as read' };
}

/** `manage_notification_subscription` — the thread subscription endpoints. */
async function manageNotificationSubscription(args, ctx) {
  const notificationId = requireString(args, 'notificationID');
  const action = requireString(args, 'action');
  const path = `/notifications/threads/${seg(notificationId)}/subscription`;

  if (action === ACTION_DELETE) {
    await ctx.client.delete(path, undefined, { signal: ctx.signal });
    return { message: 'Notification subscription deleted' };
  }

  let subscription;
  if (action === ACTION_IGNORE) subscription = await ctx.client.put(path, { ignored: true }, { signal: ctx.signal });
  else if (action === ACTION_WATCH) subscription = await ctx.client.put(path, { ignored: false, subscribed: true }, { signal: ctx.signal });
  else return fail(INVALID_ACTION);

  return { subscription: subscriptionOutput(subscription) };
}

/** `manage_repository_notification_subscription` — the repository subscription endpoints. */
async function manageRepositoryNotificationSubscription(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const action = requireString(args, 'action');
  const path = `/repos/${seg(owner)}/${seg(repo)}/subscription`;

  if (action === ACTION_DELETE) {
    await ctx.client.delete(path, undefined, { signal: ctx.signal });
    return { message: 'Repository subscription deleted' };
  }

  let subscription;
  if (action === ACTION_IGNORE) subscription = await ctx.client.put(path, { ignored: true }, { signal: ctx.signal });
  else if (action === ACTION_WATCH) subscription = await ctx.client.put(path, { ignored: false, subscribed: true }, { signal: ctx.signal });
  else return fail(INVALID_ACTION);

  return { subscription: subscriptionOutput(subscription) };
}

export default {
  dismiss_notification: dismissNotification,
  get_notification_details: getNotificationDetails,
  list_notifications: listNotifications,
  manage_notification_subscription: manageNotificationSubscription,
  manage_repository_notification_subscription: manageRepositoryNotificationSubscription,
  mark_all_notifications_read: markAllNotificationsRead,
};
