import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const source = readFileSync(resolve('public/js/admin-bookmark-list.js'), 'utf8');

function createHarness({ filtered = false } = {}) {
  const timers = [];
  const requests = [];
  const messages = [];
  const opened = [];
  let hitTarget = null;

  function makeClassList(element) {
    const classes = new Set();
    return {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toString() { return [...classes].join(' '); },
      _classes: classes,
    };
  }

  function makeElement(tagName = 'div') {
    const listeners = {};
    const element = {
      tagName: tagName.toUpperCase(),
      dataset: {},
      style: {},
      children: [],
      parentElement: null,
      value: '',
      textContent: '',
      innerText: '',
      title: '',
      draggable: false,
      isContentEditable: false,
      classList: null,
      addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
      dispatch(type, event = {}) {
        const payload = {
          type,
          target: element,
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
          clientX: 0,
          clientY: 0,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() { this.propagationStopped = true; },
          ...event,
        };
        for (const handler of listeners[type] || []) handler.call(element, payload);
        return payload;
      },
      appendChild(child) {
        child.parentElement = element;
        element.children.push(child);
        return child;
      },
      before(node) {
        const parent = element.parentElement;
        const oldIndex = parent.children.indexOf(node);
        if (oldIndex >= 0) parent.children.splice(oldIndex, 1);
        const index = parent.children.indexOf(element);
        parent.children.splice(index, 0, node);
        node.parentElement = parent;
      },
      after(node) {
        const parent = element.parentElement;
        const oldIndex = parent.children.indexOf(node);
        if (oldIndex >= 0) parent.children.splice(oldIndex, 1);
        const index = parent.children.indexOf(element);
        parent.children.splice(index + 1, 0, node);
        node.parentElement = parent;
      },
      querySelectorAll(selector) {
        if (selector === '.site-card') return element.children.filter(child => child.classList.contains('site-card'));
        return [];
      },
      closest(selector) {
        if (selector === 'button') return element.tagName === 'BUTTON' ? element : null;
        if (selector === '#configGrid .site-card') return element.classList.contains('site-card') ? element : null;
        return null;
      },
      setAttribute() {},
      setPointerCapture(id) { element._capture = id; },
      hasPointerCapture(id) { return element._capture === id; },
      releasePointerCapture(id) { if (element._capture === id) element._capture = null; },
    };
    element.classList = makeClassList(element);
    let className = '';
    Object.defineProperty(element, 'className', {
      get() { return className; },
      set(value) {
        className = String(value || '');
        element.classList._classes.clear();
        className.split(/\s+/).filter(Boolean).forEach(name => element.classList.add(name));
      },
    });
    Object.defineProperty(element, 'innerHTML', {
      get() { return element._innerHTML || ''; },
      set(value) {
        element._innerHTML = value;
        if (value === '') element.children = [];
      },
    });
    return element;
  }

  const configGrid = makeElement();
  const searchInput = makeElement('input');
  const categoryFilter = makeElement('select');
  categoryFilter.value = filtered ? '7' : '';
  const pageSizeSelect = makeElement('select');
  const nodes = {
    configGrid,
    searchInput,
    categoryFilter,
    pageSizeSelect,
    prevPage: makeElement('button'),
    nextPage: makeElement('button'),
    currentPage: makeElement(),
    totalPages: makeElement(),
  };

  const document = {
    body: makeElement('body'),
    getElementById(id) { return nodes[id] || null; },
    createElement: makeElement,
    querySelectorAll(selector) {
      if (selector === '#configGrid .site-card' || selector === '.site-card') return configGrid.querySelectorAll('.site-card');
      if (selector === '.edit-btn' || selector === '.del-btn') return [];
      return [];
    },
    elementFromPoint() { return hitTarget; },
    execCommand() {},
  };

  const sandbox = {
    document,
    console,
    URLSearchParams,
    Event: class { constructor(type) { this.type = type; } },
    confirm: () => false,
    setTimeout(fn, delay) {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).startsWith('/api/config?')) {
        return { json: async () => ({ code: 200, total: 3, page: 1, data: [
          { id: 1, name: '一', url: 'https://one.example', catelog_name: '默认' },
          { id: 2, name: '二', url: 'https://two.example', catelog_name: '默认' },
          { id: 3, name: '三', url: 'https://three.example', catelog_name: '默认' },
        ] }) };
      }
      return { json: async () => ({ code: 200 }) };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.escapeHTML = value => String(value ?? '');
  sandbox.normalizeUrl = value => value || '';
  sandbox.showMessage = (message, type) => messages.push({ message, type });
  sandbox.open = (...args) => opened.push(args);

  vm.runInNewContext(source, sandbox, { filename: 'public/js/admin-bookmark-list.js' });
  sandbox.AdminBookmarkList.init();

  async function flush() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }

  async function load() {
    await flush();
    if (filtered) {
      categoryFilter.dispatch('change', { target: categoryFilter });
      await flush();
    }
    return configGrid.children;
  }

  function runLongPress() {
    const timer = timers.find(item => item.delay === 400 && !item.cleared);
    assert.ok(timer, '应创建 400ms 长按计时器');
    timer.fn();
  }

  return {
    sandbox,
    configGrid,
    categoryFilter,
    requests,
    messages,
    opened,
    timers,
    load,
    runLongPress,
    setHitTarget(target) { hitTarget = target; },
    flush,
  };
}

test('触摸长按 400ms 后进入拖动状态', async () => {
  const harness = createHarness();
  const [card] = await harness.load();

  card.dispatch('pointerdown');
  assert.equal(card.classList.contains('bookmark-pointer-dragging'), false);
  harness.runLongPress();

  assert.equal(card.classList.contains('bookmark-pointer-dragging'), true);
  assert.equal(harness.configGrid.classList.contains('bookmark-reordering'), true);
  assert.equal(card.hasPointerCapture(1), true);
});

test('未达到长按时间时松手不进入拖动也不保存', async () => {
  const harness = createHarness();
  const [card] = await harness.load();
  const initialPosts = harness.requests.filter(call => call.url === '/api/config/batch').length;

  card.dispatch('pointerdown');
  card.dispatch('pointerup');

  assert.equal(card.classList.contains('bookmark-pointer-dragging'), false);
  assert.equal(harness.requests.filter(call => call.url === '/api/config/batch').length, initialPosts);
});

test('长按拖动到其他卡片时实时调整 DOM 顺序，松手后保存一次', async () => {
  const harness = createHarness();
  const [first, second, third] = await harness.load();

  first.dispatch('pointerdown');
  harness.runLongPress();
  harness.setHitTarget(third);
  first.dispatch('pointermove', { clientX: 30, clientY: 80 });

  assert.deepEqual(harness.configGrid.children.map(card => card.dataset.id), [2, 3, 1]);
  first.dispatch('pointerup');
  await harness.flush();

  const saves = harness.requests.filter(call => call.url === '/api/config/batch');
  assert.equal(saves.length, 1);
  assert.deepEqual(JSON.parse(saves[0].init.body).payload.orderedIds, [2, 3, 1]);
  assert.equal(first.classList.contains('bookmark-pointer-dragging'), false);
  assert.equal(harness.configGrid.classList.contains('bookmark-reordering'), false);
  assert.equal(first.hasPointerCapture(1), false);
  assert.equal(second.classList.contains('bookmark-drop-target'), false);
});

test('pointercancel 清理拖动状态并且不保存', async () => {
  const harness = createHarness();
  const [first, second] = await harness.load();

  first.dispatch('pointerdown');
  harness.runLongPress();
  harness.setHitTarget(second);
  first.dispatch('pointermove', { clientX: 20, clientY: 50 });
  first.dispatch('pointercancel');

  assert.equal(harness.requests.some(call => call.url === '/api/config/batch'), false);
  assert.equal(first.classList.contains('bookmark-pointer-dragging'), false);
  assert.equal(first.hasPointerCapture(1), false);
});

test('完成拖动后紧随的 click 不打开书签', async () => {
  const harness = createHarness();
  const [first, second] = await harness.load();

  first.dispatch('pointerdown');
  harness.runLongPress();
  harness.setHitTarget(second);
  first.dispatch('pointermove', { clientX: 10, clientY: 40 });
  first.dispatch('pointerup');
  first.dispatch('click');

  assert.equal(harness.opened.length, 0);
});

test('分类筛选状态允许触摸长按拖动并携带分类和分页参数', async () => {
  const harness = createHarness({ filtered: true });
  const [first, second, third] = await harness.load();

  assert.equal(first.draggable, true);
  first.dispatch('pointerdown');
  harness.runLongPress();
  harness.setHitTarget(third);
  first.dispatch('pointermove', { clientX: 30, clientY: 80 });
  first.dispatch('pointerup');
  await harness.flush();

  const saves = harness.requests.filter(call => call.url === '/api/config/batch');
  assert.equal(saves.length, 1);
  assert.deepEqual(JSON.parse(saves[0].init.body).payload, {
    catalogId: '7',
    orderedIds: [2, 3, 1],
    page: 1,
    pageSize: 50,
  });
  assert.equal(second.classList.contains('bookmark-drop-target'), false);
});

test('分类筛选状态允许桌面 HTML5 拖动排序', async () => {
  const harness = createHarness({ filtered: true });
  const [first, second] = await harness.load();
  const dataTransfer = { effectAllowed: '', dropEffect: '', setData() {} };

  first.dispatch('dragstart', { dataTransfer });
  second.dispatch('drop', { dataTransfer });
  await harness.flush();

  assert.equal(dataTransfer.effectAllowed, 'move');
  const saves = harness.requests.filter(call => call.url === '/api/config/batch');
  assert.equal(saves.length, 1);
  assert.equal(JSON.parse(saves[0].init.body).payload.catalogId, '7');
});
