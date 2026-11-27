/** The scroll geometry of a viewport, as read off the element. */
export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/**
 * How close to the end still counts as "at the bottom". Not zero: fractional
 * device pixels leave `scrollTop` a hair short of the maximum, and a reader who
 * nudges the wheel by a line has not asked to stop following.
 */
export const FOLLOW_BOTTOM_THRESHOLD_PX = 32;

export function distanceFromBottom({ scrollTop, scrollHeight, clientHeight }: ScrollMetrics) {
  return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

/** Whether the viewport sits at the end, within `threshold`. */
export function isAtBottom(metrics: ScrollMetrics, threshold: number) {
  return distanceFromBottom(metrics) <= threshold;
}

/**
 * Whether to keep following after a scroll event. Reaching the end resumes
 * following; only the reader moving up stops it. Position alone is not enough:
 * scroll events are dispatched a frame late, so the one fired by sticking to the
 * end can arrive after more content has landed and look far from the bottom.
 */
export function keepsFollowing(
  metrics: ScrollMetrics,
  previousScrollTop: number,
  following: boolean,
  threshold: number
) {
  if (isAtBottom(metrics, threshold)) return true;
  return following && metrics.scrollTop >= previousScrollTop;
}
