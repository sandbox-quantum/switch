import { startWebSignIn } from "../../data/api";

/** Leave for the vendor's sign-in page. The browser comes back to the
 * connector's page, which says how it ended; the caller only hears of a
 * sign-in that could not start. */
export async function leaveToSignIn(service: string): Promise<void> {
  const { url } = await startWebSignIn(service);
  window.location.assign(url);
}
