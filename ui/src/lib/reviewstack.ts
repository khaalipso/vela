// Shared by the stack of diffs and its cards: a file selected by scrolling to it or by clicking
// in it is already on screen, so the stack must not jump to it.
export const stackSel = { onScreen: null as string | null };
