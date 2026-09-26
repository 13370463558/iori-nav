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
      addEventListener(type, handler, options = false) {
        const capture = options === true || options?.capture === true;
        (listeners[type] ||= []).push({ handler, capture });
      },
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
        const handlers = listeners[type] || [];
        for (const { handler } of handlers.filter(item => item.capture)) handler.call(element, payload);
        for (const { handler } of handlers.filter(item => !item.capture)) handler.call(element, payload);
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
      hasPointerCapture() { return false; },
    };
    element.classList = makeClassList(element);
    let className = '';
    Object.defineProperty(element, 'nextSibling', {
      get() {
        if (!element.parentElement) return null;
        const index = element.parentElement.children.indexOf(element);
        return element.parentElement.children[index + 1] || null;
      },
    });
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

  const documentListeners = {};
  const document = {
    body: makeElement('body'),
    addEventListener(type, handler) { (documentListeners[type] ||= []).push(handler); },
    dispatch(type, event = {}) {
      const payload = { type, target: document, preventDefault() {}, stopPropagation() {}, ...event };
      for (const handler of documentListeners[type] || []) handler.call(document, payload);
      return payload;
    },
    getElementById(id) { return nodes[id] || null; },
    createElement: makeElement,
    querySelectorAll(selector) {
      if (selector === '#configGrid .site-card' || selector === '.site-card') return configGrid.querySelectorAll('.site-card');
      if (selector === '.edit-btn' || selector === '.del-btn') return [];
      return [];
    },
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
    flush,
  };
}

test('触摸长按 400ms 后选中卡片并显示换位提示', async () => {
  const harness = createHarness();
  const [card] = await harness.load();

  card.dispatch('pointerdown');
  assert.equal(card.classList.contains('bookmark-swap-selected'), false);
  harness.runLongPress();

  assert.equal(card.classList.contains('bookmark-swap-selected'), true);
  assert.equal(harness.configGrid.classList.contains('bookmark-swap-active'), true);
  assert.equal(card.hasPointerCapture(1), false);
  assert.deepEqual(harness.messages.at(-1), {
    message: '已选中，请点击目标书签换位',
    type: 'info',
  });
});

test('未达到长按时间时松手不选中也不保存', async () => {
  const harness = createHarness();
  const [card] = await harness.load();

  card.dispatch('pointerdown');
  card.dispatch('pointerup');

  assert.equal(card.classList.contains('bookmark-swap-selected'), false);
  assert.equal(harness.requests.some(call => call.url === '/api/config/batch'), false);
});

test('长按选中后点击目标卡片交换位置并只保存一次', async () => {
  const harness = createHarness();
  const [first, second, third] = await harness.load();

  first.dispatch('pointerdown');
  harness.runLongPress();
  third.dispatch('click');
  assert.deepEqual(harness.configGrid.children.map(card => card.dataset.id), [3, 2, 1]);
  await harness.flush();
  const saves = harness.requests.filter(call => call.url === '/api/config/batch');
  assert.equal(saves.length, 1);
  assert.deepEqual(JSON.parse(saves[0].init.body).payload.orderedIds, [3, 2, 1]);
  assert.equal(first.classList.contains('bookmark-swap-selected'), false);
  assert.equal(harness.configGrid.classList.contains('bookmark-swap-active'), false);
});

test('再次点击源卡片取消选中且不保存', async () => {
  const harness = createHarness();
  const [first] = await harness.load();

  first.dispatch('pointerdown');
  harness.runLongPress();
  first.dispatch('click');

  assert.equal(first.classList.contains('bookmark-swap-selected'), false);
  assert.equal(harness.requests.some(call => call.url === '/api/config/batch'), false);
});

test('pointercancel 取消选中且不保存', async () => {
  const harness = createHarness();
  const [first] = await harness.load();

  first.dispatch('pointerdown');
  harness.runLongPress();
  first.dispatch('pointercancel');

  assert.equal(first.classList.contains('bookmark-swap-selected'), false);
  assert.equal(harness.requests.some(call => call.url === '/api/config/batch'), false);
});

test('点击列表空白处取消选中', async () => {
  const harness = createHarness();
  const [first] = await harness.load();

  first.dispatch('pointerdown');
  harness.runLongPress();
  harness.configGrid.dispatch('click', { target: harness.configGrid });

  assert.equal(first.classList.contains('bookmark-swap-selected'), false);
});

test('选中状态下点击编辑删除按钮不触发换位', async () => {
  const harness = createHarness();
  const [first, second] = await harness.load();
  const button = harness.sandbox.document.createElement('button');

  first.dispatch('pointerdown');
  harness.runLongPress();
  second.dispatch('click', { target: button });

  assert.deepEqual(harness.configGrid.children.map(card => card.dataset.id), [1, 2, 3]);
  assert.equal(harness.requests.some(call => call.url === '/api/config/batch'), false);
  assert.equal(first.classList.contains('bookmark-swap-selected'), true);
});

test('成功换位后紧随的卡片点击不打开链接', async () => {
  const harness = createHarness();
  const [first, second] = await harness.load();

  first.dispatch('pointerdown');
  harness.runLongPress();
  second.dispatch('click');

  assert.equal(harness.opened.length, 0);
});


test('取消键和选中超时都会清理选中状态', async () => {
  const escapeHarness = createHarness();
  const [escapeCard] = await escapeHarness.load();
  escapeCard.dispatch('pointerdown');
  escapeHarness.runLongPress();
  escapeHarness.sandbox.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(escapeCard.classList.contains('bookmark-swap-selected'), false);

  const timeoutHarness = createHarness();
  const [timeoutCard] = await timeoutHarness.load();
  timeoutCard.dispatch('pointerdown');
  timeoutHarness.runLongPress();
  const timeout = timeoutHarness.timers.find(item => item.delay === 10000 && !item.cleared);
  assert.ok(timeout, '应创建选中超时计时器');
  timeout.fn();
  assert.equal(timeoutCard.classList.contains('bookmark-swap-selected'), false);
});

test('搜索状态禁止触摸换位和桌面拖拽排序', async () => {
  const harness = createHarness();
  const cards = await harness.load();
  harness.sandbox.document.getElementById('searchInput').value = '关键词';
  harness.sandbox.document.getElementById('searchInput').dispatch('input');
  const debounce = harness.timers.find(item => item.delay === 300 && !item.cleared);
  assert.ok(debounce, '应创建搜索防抖计时器');
  debounce.fn();
  await harness.flush();

  const [first] = harness.configGrid.children;
  first.dispatch('pointerdown');
  assert.equal(harness.timers.some(item => item.delay === 400 && !item.cleared), false);
  assert.equal(first.draggable, false);
  const dataTransfer = { effectAllowed: '', setData() {} };
  const dragEvent = first.dispatch('dragstart', { dataTransfer });
  assert.equal(dragEvent.defaultPrevented, true);
  assert.equal(harness.requests.some(call => call.url === '/api/config/batch'), false);
  assert.ok(harness.messages.some(item => item.message.includes('搜索状态下无法调整排序')));
});

test('分类筛选状态允许触摸换位并携带分类和分页参数', async () => {
  const harness = createHarness({ filtered: true });
  const [first, second, third] = await harness.load();

  first.dispatch('pointerdown');
  harness.runLongPress();
  third.dispatch('click');
  await harness.flush();

  const saves = harness.requests.filter(call => call.url === '/api/config/batch');
  assert.equal(saves.length, 1);
  assert.deepEqual(JSON.parse(saves[0].init.body).payload, {
    catalogId: '7',
    orderedIds: [3, 2, 1],
    page: 1,
    pageSize: 50,
  });
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
