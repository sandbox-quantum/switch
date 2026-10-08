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

/**
 * Whether the viewport should keep sticking to the end after a scroll. Following
 * is decided by position alone: scrolling up past the threshold stops it, and
 * scrolling back down to the end resumes it.
 */
export function isAtBottom(metrics: ScrollMetrics, threshold: number) {
  return distanceFromBottom(metrics) <= threshold;
}
