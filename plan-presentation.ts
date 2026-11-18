/** Hide only native wrapper markers surrounding our own styled plan document. */
export function mountPlanPresentation() {
  const changed = new Map<HTMLElement, { hidden: boolean; owner: Element }>();
  const scan = () => {
    for (const [node, saved] of changed) if (!saved.owner.isConnected) { node.hidden = saved.hidden; changed.delete(node); }
    for (const plan of document.querySelectorAll('[data-aif-plan-document]')) {
      let parent = plan.parentElement;
      for (let level = 0; parent && level < 5; level++, parent = parent.parentElement) {
        const children = Array.from(parent.children);
        const open = children.find(node => node.tagName === 'P' && node.textContent?.trim() === '<proposed_plan>');
        const close = children.find(node => node.tagName === 'P' && node.textContent?.trim() === '</proposed_plan>');
        if (!open || !close || !(open.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING)
          || !(plan.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        for (const node of [open, close] as HTMLElement[]) {
          if (!changed.has(node)) changed.set(node, { hidden: node.hidden, owner: plan });
          node.hidden = true;
        }
        break;
      }
    }
  };
  const observer = new MutationObserver(scan);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  scan();
  return () => { observer.disconnect(); for (const [node, saved] of changed) node.hidden = saved.hidden; changed.clear(); };
}
