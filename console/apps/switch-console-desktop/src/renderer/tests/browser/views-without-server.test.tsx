import { describe, expect, it } from 'vitest';
import { views, viewWorksWithoutServer, type ViewId } from '@renderer/app/view-registry';

/**
 * Which views may be drawn with nothing registered, named once.
 *
 * The flag lives on each view so the next one of its kind is not missed, and
 * that is the right place for it — but it also means no single file says what
 * the set is, and dropping the flag from Settings breaks ⌘, on a fresh install
 * while every other test stays green. This is the file that notices.
 *
 * Deliberately a whole-set comparison rather than a per-view assertion: the
 * failure worth catching is a flag that quietly appeared or disappeared, and
 * only the set catches both.
 *
 * A browser test because importing the registry pulls in every view, which
 * wants the preload bridge this project installs before a module evaluates.
 */
const CAN_BE_DRAWN_WITHOUT_A_SERVER = ['remoteHost', 'remoteHosts', 'settings'];

describe('the views that need no Switch server', () => {
  it('are these three and no others', () => {
    const ids = (Object.keys(views) as ViewId[]).filter(viewWorksWithoutServer).sort();

    expect(ids).toEqual(CAN_BE_DRAWN_WITHOUT_A_SERVER);
  });
});
