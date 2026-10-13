/**
 * Run one native view transition without making motion a requirement.
 *
 * The callback remains the source of truth. Reduced-motion users and older WebViews receive the
 * same update immediately. The data attribute exists only while the browser owns snapshots, so
 * motion.css can name the exact surfaces involved without leaking names into resting UI.
 */

type NativeViewTransition = {
  updateCallbackDone: Promise<void>;
  finished: Promise<void>;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => NativeViewTransition;
};

let owner = 0;

export async function withViewTransition(
  name: "git-commit" | "git-send" | "tab-forward" | "tab-backward",
  update: () => void | Promise<void>,
): Promise<void> {
  const start = (document as ViewTransitionDocument).startViewTransition;
  if (!start || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    await update();
    return;
  }

  const mine = ++owner;
  const root = document.documentElement;
  root.dataset.panelTransition = name;
  let transition: NativeViewTransition;
  try {
    transition = start.call(document, update);
  } catch {
    delete root.dataset.panelTransition;
    await update();
    return;
  }

  const clean = () => {
    if (owner === mine) delete root.dataset.panelTransition;
  };
  transition.finished.then(clean, clean);
  await transition.updateCallbackDone;
}
