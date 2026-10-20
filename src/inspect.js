'use strict';

/**
 * Page inspection used by the coordinate commands: hit testing (`element-at`,
 * routing decisions for click-at / drag), scroll-container discovery, and
 * "what is focused".
 *
 * Everything runs through Playwright's normal evaluate (Patchright executes it
 * in an ISOLATED world): DOM APIs such as elementFromPoint / getComputedStyle
 * work there and no main-world script is injected. The functions passed to
 * evaluate are serialised by Playwright, so each one is fully self-contained.
 *
 * Iframes (same- AND cross-origin) are drilled into with
 * elementHandle.contentFrame(), translating the point by the iframe's content
 * box offset. Open shadow roots are drilled into inside the page function.
 *
 * @module inspect
 */

// ---------------------------------------------------------------------------
// page-side functions (self-contained!)
// ---------------------------------------------------------------------------

/** Deep elementFromPoint through open shadow roots. */
function pageElementAt(pt) {
  let el = document.elementFromPoint(pt.x, pt.y);
  let guard = 0;
  while (el && el.shadowRoot && guard++ < 12) {
    const inner = el.shadowRoot.elementFromPoint(pt.x, pt.y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/** Content-box origin and border box of an iframe/frame element. */
function pageFrameBox(el) {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const px = (v) => parseFloat(v) || 0;
  // computed border widths are the USED ones (snapped to device pixels: a 3px border is 2.667px at dpr 1.5),
  // unlike the integer clientLeft/clientTop
  return {
    left: r.left, top: r.top, width: r.width, height: r.height,
    cl: px(cs.borderLeftWidth), ct: px(cs.borderTopWidth),
    pl: px(cs.paddingLeft), pt: px(cs.paddingTop),
  };
}

function pageIsFrameElement(el) { return /^(iframe|frame)$/i.test(el.tagName); }

/** Describe an element for `element-at`. Box is in this frame's viewport CSS px. */
function pageDescribe(el) {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const tag = el.tagName.toLowerCase();
  const r = el.getBoundingClientRect();
  const cs = win.getComputedStyle(el);
  const attr = (n) => el.getAttribute(n);
  const rnd = (n) => Math.round(n * 100) / 100;

  const clsAttr = attr('class');
  const classes = clsAttr ? clsAttr.split(/\s+/).filter(Boolean) : [];
  const text = ((el.innerText != null ? el.innerText : el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const name = attr('aria-label') || attr('title') || attr('alt') || null;

  // role: explicit attribute, else a small implicit map
  let role = attr('role');
  if (!role) {
    if (tag === 'input') {
      const type = (attr('type') || 'text').toLowerCase();
      const map = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', search: 'searchbox', number: 'spinbutton' };
      role = type === 'hidden' ? null : (map[type] || 'textbox');
    } else {
      const map = {
        a: el.hasAttribute('href') ? 'link' : null, button: 'button', select: el.multiple ? 'listbox' : 'combobox',
        textarea: 'textbox', img: 'img', nav: 'navigation', main: 'main', ul: 'list', ol: 'list', li: 'listitem',
        table: 'table', form: 'form', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
        header: 'banner', footer: 'contentinfo', aside: 'complementary', dialog: 'dialog', progress: 'progressbar',
      };
      role = map[tag] || null;
    }
  }

  // href of the nearest link (a click on a <span> inside a link follows the link)
  let href = null;
  const link = el.closest ? el.closest('a[href], area[href]') : null;
  if (link) {
    try { href = new URL(link.getAttribute('href'), doc.baseURI).href; } catch (e) { href = link.getAttribute('href'); }
  }

  // EFFECTIVE draggable: any ancestor-or-self whose IDL `draggable` is true
  // (img and a[href] are draggable by default and report true)
  let draggable = false;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.draggable === true) { draggable = true; break; }
  }

  let editable = !!el.isContentEditable;
  if (!editable) {
    if (tag === 'textarea') editable = !el.disabled && !el.readOnly;
    else if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      editable = !el.disabled && !el.readOnly &&
        !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden'].includes(t);
    }
  }

  // short, unique CSS selector
  const esc = (s) => (win.CSS && win.CSS.escape ? win.CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));
  const root = el.getRootNode();
  const count = (sel) => { try { return root.querySelectorAll(sel).length; } catch (e) { return 99; } };
  let selectorHint;
  if (el.id && count('#' + esc(el.id)) === 1) selectorHint = '#' + esc(el.id);
  else {
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n !== el && n.id && count('#' + esc(n.id)) === 1) { parts.unshift('#' + esc(n.id)); break; }
      let seg = n.tagName.toLowerCase();
      const cls = (n.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) seg += '.' + cls.map(esc).join('.');
      const sib = n.parentElement ? Array.prototype.filter.call(n.parentElement.children, (c) => c.tagName === n.tagName) : [];
      if (sib.length > 1) seg += ':nth-of-type(' + (sib.indexOf(n) + 1) + ')';
      parts.unshift(seg);
      if (count(parts.join(' > ')) === 1) break;
    }
    selectorHint = parts.join(' > ');
  }

  return {
    tag, id: el.id || null, classes, role, name, text, href,
    box: { x: rnd(r.left), y: rnd(r.top), width: rnd(r.width), height: rnd(r.height) },
    cursor: cs.cursor, draggable, editable, selectorHint,
  };
}

/** What the focused element is (for type-focused / paste-focused). */
function pageFocusProbe(el) {
  const tag = el.tagName.toLowerCase();
  let editable = !!el.isContentEditable;
  if (!editable) {
    if (tag === 'textarea') editable = !el.disabled && !el.readOnly;
    else if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      editable = !el.disabled && !el.readOnly &&
        !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden'].includes(t);
    }
  }
  return { tag, editable, isFrame: /^(iframe|frame)$/i.test(el.tagName), id: el.id || null, type: el.type || null };
}

function pageActiveElement() {
  let a = document.activeElement;
  let guard = 0;
  while (a && a.shadowRoot && a.shadowRoot.activeElement && guard++ < 12) a = a.shadowRoot.activeElement;
  return a;
}

/**
 * Pick the scroll container for a wheel at `start` along `axis`/`dir`:
 * the nearest ancestor that scrolls on that axis (overflow auto|scroll|overlay AND it overflows).
 * Like a browser's scroll chaining, an ancestor that still has room in the
 * requested direction wins over a nearer one that is already at its edge; if
 * nobody has room the nearest scrollable one is returned (the scroll is then a
 * no-op, reported as such). No scrollable ancestor -> document.scrollingElement.
 */
function pagePickContainer(start, opts) {
  const axis = opts.axis, dir = opts.dir;
  const doc = start ? start.ownerDocument : document;
  const win = doc.defaultView;
  const se = doc.scrollingElement || doc.documentElement;
  const size = (e) => (axis === 'x' ? [e.scrollWidth, e.clientWidth] : [e.scrollHeight, e.clientHeight]);
  const pos = (e) => (axis === 'x' ? e.scrollLeft : e.scrollTop);
  const overflows = (e) => { const s = size(e); return s[0] > s[1] + 1; };
  const scrollableStyle = (e) => {
    const cs = win.getComputedStyle(e);
    return /^(auto|scroll|overlay)$/.test(axis === 'x' ? cs.overflowX : cs.overflowY);
  };
  const hasRoom = (e) => {
    const s = size(e);
    return dir >= 0 ? pos(e) + s[1] < s[0] - 1 : pos(e) > 1;
  };
  const candidates = [];
  for (let n = start; n; ) {
    if (n !== doc.documentElement && n !== doc.body && scrollableStyle(n) && overflows(n)) candidates.push(n);
    // climb through shadow roots too
    n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
  }
  const bodyScrolls = doc.body && doc.body !== se && scrollableStyle(doc.body) && overflows(doc.body) && !overflows(se);
  if (overflows(se)) candidates.push(se);
  else if (bodyScrolls) candidates.push(doc.body);
  const withRoom = candidates.find(hasRoom);
  return withRoom || candidates[0] || se;
}

/** { x, y, maxX, maxY } scroll state of an element. */
function pageScrollState(el) {
  return {
    x: el.scrollLeft, y: el.scrollTop,
    maxX: Math.max(0, el.scrollWidth - el.clientWidth), maxY: Math.max(0, el.scrollHeight - el.clientHeight),
  };
}

function pageDescribeContainer(el) {
  const doc = el.ownerDocument;
  const isDocument = el === doc.scrollingElement || el === doc.documentElement;
  const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3);
  return { tag: el.tagName.toLowerCase(), id: el.id || null, classes: cls, isDocument };
}

// ---------------------------------------------------------------------------
// Node-side orchestration
// ---------------------------------------------------------------------------

const MAX_FRAME_DEPTH = 12;

/**
 * Walk from the main frame down through iframes to the innermost frame
 * containing the viewport point (x, y).
 * @returns {Promise<{frame, lx:number, ly:number, ox:number, oy:number, chain:object[], element: object|null}>}
 *   (lx, ly) = the point in the innermost frame's coordinates; (ox, oy) = that
 *   frame's content origin in page viewport coordinates; `element` = an
 *   ElementHandle for the (non-frame) element under the point, owned by the caller.
 */
async function locateFrame(page, x, y) {
  let frame = page.mainFrame();
  let ox = 0, oy = 0;
  const chain = [];
  for (let depth = 0; depth < MAX_FRAME_DEPTH; depth++) {
    const lx = x - ox, ly = y - oy;
    let handle;
    try { handle = await frame.evaluateHandle(pageElementAt, { x: lx, y: ly }); }
    catch { return { frame, lx, ly, ox, oy, chain, element: null }; }
    const el = handle.asElement();
    if (!el) { await handle.dispose().catch(() => {}); return { frame, lx, ly, ox, oy, chain, element: null }; }
    let isFrame = false;
    try { isFrame = await el.evaluate(pageIsFrameElement); } catch { /* detached */ }
    if (isFrame) {
      const child = await el.contentFrame().catch(() => null);
      if (child) {
        const m = await el.evaluate(pageFrameBox);
        chain.push({
          url: child.url(),
          box: { x: round2(ox + m.left), y: round2(oy + m.top), width: round2(m.width), height: round2(m.height) },
        });
        ox += m.left + m.cl + m.pl;
        oy += m.top + m.ct + m.pt;
        await el.dispose().catch(() => {});
        frame = child;
        continue;
      }
    }
    return { frame, lx, ly, ox, oy, chain, element: el };
  }
  return { frame, lx: x - ox, ly: y - oy, ox, oy, chain, element: null };
}

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Hit-test a viewport CSS point. `hit` is the innermost element (box in page
 * viewport CSS px), `frames` the iframe chain that was drilled through.
 */
async function hitTest(page, x, y) {
  const loc = await locateFrame(page, x, y);
  if (!loc.element) return { hit: null, frames: loc.chain };
  try {
    const info = await loc.element.evaluate(pageDescribe);
    info.box.x = round2(info.box.x + loc.ox);
    info.box.y = round2(info.box.y + loc.oy);
    return { hit: info, frames: loc.chain };
  } catch {
    return { hit: null, frames: loc.chain };
  } finally {
    await loc.element.dispose().catch(() => {});
  }
}

/**
 * The scroll container a wheel at (x, y) would act on (see pagePickContainer).
 * Returns { handle, descriptor } — dispose the handle when done.
 */
async function findScrollContainer(page, x, y, axis, dir) {
  const loc = await locateFrame(page, x, y);
  const startArg = loc.element || null;
  let handle;
  if (startArg) {
    handle = await startArg.evaluateHandle(pagePickContainer, { axis, dir });
    await startArg.dispose().catch(() => {});
  } else {
    handle = await loc.frame.evaluateHandle((o) => {
      const doc = document; const se = doc.scrollingElement || doc.documentElement; return se;
    }, { axis, dir });
  }
  const descriptor = await handle.evaluate(pageDescribeContainer);
  return { handle, descriptor, frame: loc.frame };
}

/** Scroll state { x, y, maxX, maxY } of a container handle. */
function containerState(handle) { return handle.evaluate(pageScrollState); }

/**
 * ElementHandle of the focused element (drilling through same- and cross-origin
 * iframes), or null. The caller disposes it.
 */
async function focusedHandle(page) {
  let frame = page.mainFrame();
  for (let depth = 0; depth < MAX_FRAME_DEPTH; depth++) {
    let h;
    try { h = await frame.evaluateHandle(pageActiveElement); } catch { return null; }
    const el = h.asElement();
    if (!el) { await h.dispose().catch(() => {}); return null; }
    let isFrame = false;
    try { isFrame = await el.evaluate(pageIsFrameElement); } catch { /* detached */ }
    if (isFrame) {
      const child = await el.contentFrame().catch(() => null);
      if (child) { await el.dispose().catch(() => {}); frame = child; continue; }
    }
    return el;
  }
  return null;
}

/** The focused element: { tag, editable, id, type }. */
async function focusedInfo(page) {
  const el = await focusedHandle(page);
  if (!el) return { tag: null, editable: false };
  try {
    const info = await el.evaluate(pageFocusProbe);
    return { tag: info.tag, editable: info.isFrame ? false : info.editable, id: info.id, type: info.type };
  } catch { return { tag: null, editable: false }; }
  finally { await el.dispose().catch(() => {}); }
}

/** Current text of the focused field: { kind: 'value'|'ce'|'none', text, ss?, se? }. */
function pageReadField(el) {
  const tag = el.tagName.toLowerCase();
  if ((tag === 'input' || tag === 'textarea') && typeof el.value === 'string') {
    let ss = null, se = null;
    try { ss = el.selectionStart; se = el.selectionEnd; } catch (e) { /* types without selection */ }
    return { kind: 'value', text: el.value, ss, se };
  }
  if (el.isContentEditable) return { kind: 'ce', text: el.innerText != null ? el.innerText : el.textContent };
  return { kind: 'none', text: '' };
}

async function readFocusedField(page) {
  const el = await focusedHandle(page);
  if (!el) return { kind: 'none', text: '' };
  try { return await el.evaluate(pageReadField); }
  catch { return { kind: 'none', text: '' }; }
  finally { await el.dispose().catch(() => {}); }
}

module.exports = { hitTest, locateFrame, findScrollContainer, containerState, focusedHandle, focusedInfo, readFocusedField };
