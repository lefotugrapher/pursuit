// Shared fixture helpers for the apply-runner tests. Served by the local test server only.
// - __collect(root): snapshot of every control's value, keyed by name/id (files → [{name,size}]).
// - __send(name, data): POSTs the snapshot to the test server, which records it.
// - __reactSelect(container, options): minimal imitation of react-select as used by
//   job-boards.greenhouse.io (role=combobox input, .select__menu with role=option rows,
//   .select__single-value once chosen, hidden required input mirrors the value).
(function () {
  function collect(root) {
    var out = {};
    root.querySelectorAll('input, select, textarea').forEach(function (el) {
      var key = el.name || el.id;
      if (!key) return;
      if (el.type === 'hidden' && !el.hasAttribute('data-record')) return;
      if (el.type === 'file') {
        out[key] = Array.prototype.map.call(el.files || [], function (f) { return { name: f.name, size: f.size }; });
        return;
      }
      if (el.type === 'radio') { if (el.checked) out[key] = el.value; return; }
      if (el.type === 'checkbox') { if (el.checked) (out[key] = out[key] || []).push(el.value); return; }
      if (el.getAttribute('role') === 'combobox') { out[key] = el.getAttribute('data-selected') || ''; return; }
      out[key] = el.value;
    });
    root.querySelectorAll('[data-yesno]').forEach(function (g) { out[g.getAttribute('data-yesno')] = g.getAttribute('data-value') || ''; });
    return out;
  }

  function send(name, data) {
    return fetch('/__submit/' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
  }

  function reactSelect(container, options) {
    var input = container.querySelector('input[role="combobox"]');
    var shell = container.querySelector('.select-shell');
    var valueBox = container.querySelector('.select__value-container');
    var placeholder = container.querySelector('.select__placeholder');
    var mirror = container.querySelector('input[aria-hidden="true"]');
    var control = container.querySelector('.select__control');
    var menu = null;

    function close() {
      if (menu) { menu.remove(); menu = null; }
      input.setAttribute('aria-expanded', 'false');
    }
    function choose(text) {
      var old = valueBox.querySelector('.select__single-value');
      if (old) old.remove();
      var v = document.createElement('div');
      v.className = 'select__single-value';
      v.textContent = text;
      valueBox.insertBefore(v, valueBox.firstChild);
      if (placeholder) placeholder.style.display = 'none';
      input.value = '';
      input.setAttribute('data-selected', text);
      if (mirror) mirror.value = text;
      close();
      container.dispatchEvent(new CustomEvent('select-change', { bubbles: true, detail: text }));
    }
    function open(filter) {
      close();
      var q = (filter || '').toLowerCase();
      menu = document.createElement('div');
      menu.className = 'select__menu';
      var list = document.createElement('div');
      list.className = 'select__menu-list';
      list.setAttribute('role', 'listbox');
      options.filter(function (o) { return !q || o.toLowerCase().indexOf(q) >= 0; }).forEach(function (o, i) {
        var row = document.createElement('div');
        row.className = 'select__option' + (i === 0 ? ' select__option--is-focused' : '');
        row.setAttribute('role', 'option');
        row.textContent = o;
        row.addEventListener('mousedown', function (e) { e.preventDefault(); });
        row.addEventListener('click', function () { choose(o); });
        list.appendChild(row);
      });
      if (!list.children.length) {
        var none = document.createElement('div');
        none.className = 'select__menu-notice--no-options';
        none.textContent = 'No options';
        list.appendChild(none);
      }
      menu.appendChild(list);
      shell.appendChild(menu);
      input.setAttribute('aria-expanded', 'true');
    }
    control.addEventListener('mousedown', function (e) {
      if (e.target !== input) e.preventDefault();
      input.focus();
      if (menu) close(); else open(input.value);
    });
    input.addEventListener('input', function () { open(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' && !menu) { open(input.value); e.preventDefault(); }
      else if (e.key === 'Escape') close();
      else if (e.key === 'Enter' && menu) {
        var first = menu.querySelector('[role="option"]');
        if (first) { choose(first.textContent); e.preventDefault(); }
      }
    });
    input.addEventListener('blur', function () { setTimeout(close, 150); });
  }

  // Like collect(), but walks open shadow roots too (web-component forms such as SmartRecruiters').
  function collectDeep(root) {
    var out = {};
    function walk(node) {
      node.querySelectorAll('*').forEach(function (el) {
        if (el.matches('input, select, textarea')) {
          var key = el.name || el.id;
          if (!key) return;
          if (el.type === 'hidden' && !el.hasAttribute('data-record')) return;
          if (el.type === 'file') { out[key] = Array.prototype.map.call(el.files || [], function (f) { return { name: f.name, size: f.size }; }); return; }
          if (el.type === 'radio') { if (el.checked) out[key] = el.value; return; }
          if (el.type === 'checkbox') { if (el.checked) (out[key] = out[key] || []).push(el.value); return; }
          if (el.tagName === 'SELECT') { out[key] = el.value; return; }
          out[key] = el.value;
        }
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    }
    walk(root);
    return out;
  }

  window.__collect = collect;
  window.__collectDeep = collectDeep;
  window.__send = send;
  window.__reactSelect = reactSelect;
})();
