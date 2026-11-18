import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountPlanPresentation } from '../plan-presentation.ts';

test('native markers are hidden only around a styled document and are restored on unload', async () => {
  const dom = new JSDOM('<main><div id="plain"><p>&lt;proposed_plan&gt;</p><p>Example</p><p>&lt;/proposed_plan&gt;</p></div><article><p id="open">&lt;proposed_plan&gt;</p><section data-aif-plan-document="true">Plan</section><p id="close">&lt;/proposed_plan&gt;</p></article></main>');
  for (const key of ['document', 'Node', 'MutationObserver']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
  const dispose = mountPlanPresentation();
  try {
    assert.equal((document.getElementById('open') as HTMLElement).hidden, true);
    assert.equal((document.getElementById('close') as HTMLElement).hidden, true);
    assert.equal((document.querySelector('#plain p') as HTMLElement).hidden, false);
  } finally { dispose(); }
  assert.equal((document.getElementById('open') as HTMLElement).hidden, false);
  assert.equal((document.getElementById('close') as HTMLElement).hidden, false);
  dom.window.close();
});
