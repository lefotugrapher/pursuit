// In-page scripts for the apply runner, kept as plain JS strings.
//
// Why strings: Playwright serialises evaluate() callbacks with Function#toString, and tsx/esbuild
// (keepNames) and Next's bundler inject helpers such as `__name` into compiled functions, which do
// not exist in the page. A string is executed verbatim, so it behaves the same in every runtime.
// Keep these ES2020, no backticks, no `${`.
//
// Every scan walks open shadow roots too (SmartRecruiters and other web-component forms render their
// inputs inside them); Playwright's CSS locators pierce open shadow roots, so tagged controls stay
// reachable from Node.

/** Attribute names used to tag discovered controls so Node-side locators can find them again. */
export const FIELD_ATTR = 'data-pursuit-field';
export const OPTION_ATTR = 'data-pursuit-option';
export const CONTAINER_ATTR = 'data-pursuit-container';
export const ROOT_ATTR = 'data-pursuit-root';

/** Shape returned by SCAN_FIELDS_JS for each discovered field. */
export interface RawField {
  idx: number;
  kind: 'text' | 'email' | 'tel' | 'url' | 'number' | 'date' | 'textarea' | 'select' | 'combobox' | 'radio' | 'checkbox' | 'checkbox-group' | 'yesno' | 'file';
  label: string;
  rawLabel: string;
  required: boolean;
  options: string[];
  optionDomIndex: number[];
  name: string;
  id: string;
  type: string;
  autocomplete: string;
  placeholder: string;
  hasValue: boolean;
  eeoSection: boolean;
  hasManualToggle: boolean;
  /** Current value of a text-like control (truncated), '' otherwise. */
  value?: string;
  /** Nearest fieldset / ARIA group / phone widget, so a phone number can pair with its dial-code picker. */
  group?: string;
}

export interface ScanArgs {
  root: string | null;
  fileNames: string[];
}

/** Shared in-page helpers (composed-tree walking), prepended to the scripts below. */
const DOM_HELPERS = String.raw`
  function parentC(el) { return el.parentElement || (el.getRootNode && el.getRootNode() && el.getRootNode().host) || null; }
  function closestC(el, sel) { var n = el; while (n) { if (n.nodeType === 1 && n.matches && n.matches(sel)) return n; n = parentC(n); } return null; }
  function rootOf(el) { var r = el.getRootNode ? el.getRootNode() : document; return (r && r.querySelector) ? r : document; }
  function byId(el, id) { var r = rootOf(el); return (r.getElementById ? r.getElementById(id) : null) || document.getElementById(id); }
  function deepAll(node, sel, out) {
    var all = node.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.matches(sel)) out.push(el);
      if (el.shadowRoot) deepAll(el.shadowRoot, sel, out);
    }
    return out;
  }
`;

/**
 * Discovers form controls under `root` (or the body), tags them with FIELD_ATTR/OPTION_ATTR/CONTAINER_ATTR,
 * and returns RawField[]. Call as `(${SCAN_FIELDS_JS})(args)`.
 */
export const SCAN_FIELDS_JS = String.raw`(function (args) {
  ${DOM_HELPERS}
  var FIELD = 'data-pursuit-field', OPT = 'data-pursuit-option', CONT = 'data-pursuit-container', GRP = 'data-pursuit-group';
  var root = (args.root && document.querySelector(args.root)) || document.body;
  deepAll(document, '[' + FIELD + '],[' + OPT + '],[' + CONT + '],[' + GRP + ']', []).forEach(function (el) {
    el.removeAttribute(FIELD); el.removeAttribute(OPT); el.removeAttribute(CONT); el.removeAttribute(GRP);
  });

  var GENERIC = /^(attach|upload|upload file|upload files|upload file\(s\)|upload a file|choose file|choose a file|enter manually|browse|select file|dropbox|google drive|paste)$/i;
  var CONTAINER_SEL = '.application-question, .ashby-application-form-field-entry, .file-upload, .eeoc__question__wrapper, .field-wrapper, fieldset, .form-group, .field, [class*="field-entry"], [class*="question"], li';
  var HEADING_SEL = 'legend, .application-label, .ashby-application-form-question-title, .upload-label, label, [class*="label"], [class*="title"], h2, h3, h4, h5';
  var EEO_SEL = '.eeoc__container, #eeoc_fields, [class*="eeoc"], [class*="eeo-"], [id*="eeo"], [class*="demographic"], [id*="demographic"]';
  var GROUP_SEL = 'fieldset, [role="group"], [role="radiogroup"], .phone-input, [class*="phone-input"], [class*="PhoneInput"], [class*="phone-field"], [class*="phoneField"]';
  var MANUAL_RE = /enter manually|paste|write it here|write (it )?instead|type it (here|instead)|type here instead/i;
  var PLACEHOLDER_RE = /^(select|choose|please select|pick|select an option|select\.\.\.|--|–|—)/i;

  function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function shown(el) {
    if (!el) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }
  function textOf(node) {
    if (!node) return '';
    var c = node.cloneNode(true);
    c.querySelectorAll('input, select, textarea, option, script, style, svg, button, [role="listbox"], .select__menu, .application-field, ul[data-qa]').forEach(function (x) { x.remove(); });
    return clean(c.textContent);
  }
  function hasControl(node) { return !!node.querySelector('input, select, textarea'); }
  function precedes(a, b) { return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }
  function sameField(c, el) {
    if (c === el || el.contains(c)) return true;
    var n = el.getAttribute && el.getAttribute('name');
    return !!n && c.getAttribute('name') === n && (c.type === 'radio' || c.type === 'checkbox');
  }
  // A heading belongs to el only if no other field's control sits between them (otherwise a wide
  // container such as .application--questions would hand el the previous question's label).
  function foreignControlBetween(h, el, container) {
    var cs = container.querySelectorAll('input:not([type="hidden"]), select, textarea');
    for (var k = 0; k < cs.length; k++) {
      var c = cs[k];
      if (!sameField(c, el) && precedes(h, c) && precedes(c, el)) return true;
    }
    return false;
  }
  function headingFor(el) {
    var container = closestC(el, CONTAINER_SEL);
    var hops = 0;
    while (container && hops < 3) {
      var cands = Array.prototype.slice.call(container.querySelectorAll(HEADING_SEL));
      var best = null;
      for (var i = 0; i < cands.length; i++) {
        var h = cands[i];
        if (h.contains(el) || hasControl(h) || !precedes(h, el)) continue;
        if (foreignControlBetween(h, el, container)) continue;
        var t = textOf(h);
        if (!t || GENERIC.test(t.replace(/[*✱]/g, '').trim())) continue;
        best = h;
      }
      if (best) return best;
      var up = parentC(container);
      container = up ? closestC(up, CONTAINER_SEL) : null;
      hops++;
    }
    return null;
  }
  function hostLabel(el) {
    var r = el.getRootNode && el.getRootNode();
    var host = r && r.host;
    if (!host) return null;
    var t = host.getAttribute('label') || host.getAttribute('aria-label') || host.getAttribute('data-label') || host.getAttribute('placeholder');
    if (t && !GENERIC.test(clean(t))) return { text: clean(t) + (host.hasAttribute('required') ? ' *' : ''), els: [] };
    if (host.id) {
      var lf = document.querySelector('label[for="' + CSS.escape(host.id) + '"]');
      if (lf && textOf(lf)) return { text: textOf(lf), els: [lf] };
    }
    var wrap = host.closest('label');
    if (wrap && textOf(wrap)) return { text: textOf(wrap), els: [wrap] };
    return null;
  }
  function labelElFor(el) {
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var parts = by.split(/\s+/).map(function (id) { return byId(el, id); }).filter(Boolean);
      var joined = parts.map(textOf).join(' ');
      if (parts.length && clean(joined)) return { text: joined, els: parts };
    }
    if (el.id) {
      var lf = rootOf(el).querySelector('label[for="' + CSS.escape(el.id) + '"]') || document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lf) {
        var t = textOf(lf);
        if (t && !GENERIC.test(t)) return { text: t, els: [lf] };
      }
    }
    var wrap = el.closest('label');
    if (wrap) {
      var inner = wrap.querySelector('.application-label');
      var wt = textOf(inner || wrap);
      if (wt && !GENERIC.test(wt)) return { text: wt, els: [inner || wrap] };
    }
    var aria = el.getAttribute('aria-label');
    if (aria && !GENERIC.test(aria)) return { text: clean(aria), els: [] };
    var h = headingFor(el);
    if (h) return { text: textOf(h), els: [h] };
    var hl = hostLabel(el);
    if (hl) return hl;
    return { text: clean(el.getAttribute('placeholder') || el.getAttribute('name') || el.id || ''), els: [] };
  }
  function optionLabel(input) {
    var wrap = input.closest('label');
    if (wrap) { var t = textOf(wrap); if (t) return t; }
    if (input.id) {
      var lf = rootOf(input).querySelector('label[for="' + CSS.escape(input.id) + '"]');
      if (lf) { var t2 = textOf(lf); if (t2) return t2; }
    }
    var sib = input.nextElementSibling;
    if (sib && !hasControl(sib)) { var t3 = clean(sib.textContent); if (t3) return t3; }
    var hl = hostLabel(input);
    if (hl) return hl.text.replace(/\s*\*$/, '');
    return clean(input.value || '');
  }
  function groupRequired(el) {
    if (closestC(el, '[aria-required="true"], [data-required="true"]') && !el.matches('[aria-required="false"]')) return true;
    var grp = closestC(el, '[role="group"][aria-labelledby], [role="radiogroup"][aria-labelledby]');
    if (grp) {
      var ids = (grp.getAttribute('aria-labelledby') || '').split(/\s+/);
      for (var i = 0; i < ids.length; i++) {
        var lab = ids[i] && byId(grp, ids[i]);
        if (lab && /[*✱]|\(required\)/i.test(lab.textContent || '')) return true;
      }
    }
    return false;
  }
  function isRequired(el, lab) {
    if (el.required || el.getAttribute('aria-required') === 'true') return true;
    if (/[*✱]/.test(lab.text)) return true;
    for (var i = 0; i < lab.els.length; i++) {
      var le = lab.els[i];
      if (le.querySelector('.required, [class*="required"]')) return true;
      if (/required/i.test(le.className || '')) return true;
    }
    if (closestC(el, '.required-field')) return true;
    return groupRequired(el);
  }
  function cleanLabel(t) {
    return clean(t.replace(/[*✱]\s*\(?required\)?/ig, ' ').replace(/[*✱]/g, ' ').replace(/\(required\)/ig, ' ')).replace(/[:\s]+$/, '');
  }

  var fields = [];
  var seq = 0;
  var groups = {};
  var groupSeq = 0;
  var fileNames = (args.fileNames || []).map(function (n) { return n.toLowerCase(); });

  function groupOf(el) {
    var g = closestC(el, GROUP_SEL);
    if (!g) return '';
    if (!g.hasAttribute(GRP)) g.setAttribute(GRP, String(groupSeq++));
    return g.getAttribute(GRP);
  }
  function push(f, el) { f.idx = seq++; el.setAttribute(FIELD, String(f.idx)); fields.push(f); return f; }
  function base(el, kind, lab) {
    return {
      idx: -1, kind: kind, label: cleanLabel(lab.text), rawLabel: lab.text, required: isRequired(el, lab),
      options: [], optionDomIndex: [], name: el.getAttribute('name') || '', id: el.id || '',
      type: (el.getAttribute('type') || el.tagName).toLowerCase(), autocomplete: el.getAttribute('autocomplete') || '',
      placeholder: el.getAttribute('placeholder') || '', hasValue: false, eeoSection: !!closestC(el, EEO_SEL), hasManualToggle: false,
      value: '', group: groupOf(el),
    };
  }

  var controls = deepAll(root, 'input, select, textarea', []);
  for (var i = 0; i < controls.length; i++) {
    var el = controls[i];
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || (tag === 'input' ? 'text' : tag)).toLowerCase();
    if (el.disabled) continue;
    if (/^(hidden|submit|button|reset|image|password|search)$/.test(type)) continue;
    if (type !== 'file' && (el.getAttribute('aria-hidden') === 'true' || closestC(el, '[aria-hidden="true"]'))) continue;

    if (type === 'radio' || type === 'checkbox') {
      var key = type + ':' + (el.name || el.id || ('anon' + i));
      var lbl = el.closest('label');
      var forLbl = el.id ? rootOf(el).querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
      var vis = shown(el) || (lbl && shown(lbl)) || (forLbl && shown(forLbl));
      if (!vis) continue;
      var g = groups[key];
      if (!g) {
        var glab = headingFor(el);
        var labInfo = glab ? { text: textOf(glab), els: [glab] } : labelElFor(el);
        g = base(el, type === 'radio' ? 'radio' : 'checkbox', labInfo);
        g.inputs = [];
        groups[key] = g;
        push(g, el);
      }
      el.setAttribute(FIELD, String(g.idx));
      el.setAttribute(OPT, String(g.inputs.length));
      g.inputs.push(el);
      g.options.push(optionLabel(el));
      if (el.required || el.getAttribute('aria-required') === 'true') g.required = true;
      if (el.checked) g.hasValue = true;
      continue;
    }

    if (type === 'file') {
      var fwrap = closestC(el, '.file-upload, .ashby-application-form-input-file, .application-question, .field-wrapper, .ashby-application-form-field-entry') || parentC(el);
      if (!fwrap || !shown(fwrap)) continue;
      var flab = labelElFor(el);
      var ff = push(base(el, 'file', flab), el);
      fwrap.setAttribute(CONT, String(ff.idx));
      var ftext = (fwrap.textContent || '').toLowerCase();
      ff.hasValue = (el.files && el.files.length > 0) || fileNames.some(function (n) { return n && ftext.indexOf(n) >= 0; });
      var scope = closestC(fwrap, 'section, fieldset, li, .field-wrapper, .application-question') || fwrap.parentElement || fwrap;
      ff.hasManualToggle = Array.prototype.some.call(scope.querySelectorAll('button'), function (b) { return MANUAL_RE.test(b.textContent || ''); });
      continue;
    }

    if (!shown(el)) continue;
    var lab = labelElFor(el);

    if (el.getAttribute('role') === 'combobox') {
      var f = push(base(el, 'combobox', lab), el);
      var cont = el.closest('.select__container') || el.closest('.select') || el.closest('[class*="select-shell"]') || parentC(el) || el;
      cont.setAttribute(CONT, String(f.idx));
      var reactSelect = !!cont.querySelector('.select__control, [class*="select__control"], [class*="-control"]');
      f.hasValue = reactSelect
        ? !!cont.querySelector('.select__single-value, [class*="single-value"], [class*="singleValue"], .select__multi-value, [class*="multi-value"]')
        : clean(el.value).length > 0;
      f.value = clean(el.value || '').slice(0, 200);
      continue;
    }

    if (tag === 'select') {
      var sf = base(el, 'select', lab);
      for (var o = 0; o < el.options.length; o++) {
        var opt = el.options[o];
        var ot = clean(opt.textContent);
        if (!ot || (opt.value === '' && o === 0) || /^(select|choose|please select|--)/i.test(ot)) continue;
        sf.options.push(ot);
        sf.optionDomIndex.push(o);
      }
      var sel = el.options[el.selectedIndex];
      sf.hasValue = !!sel && sf.optionDomIndex.indexOf(el.selectedIndex) >= 0;
      push(sf, el);
      continue;
    }

    var kind = tag === 'textarea' ? 'textarea' : (/^(email|tel|url|number|date)$/.test(type) ? type : 'text');
    var tf = push(base(el, kind, lab), el);
    tf.hasValue = clean(el.value).length > 0;
    tf.value = clean(el.value).slice(0, 200);
  }

  // Custom dropdowns rendered as buttons (Downshift, Headless UI, design-system selects).
  var combos = deepAll(root, '[role="combobox"]:not(input):not(select):not(textarea), button[aria-haspopup="listbox"]', []);
  for (var c = 0; c < combos.length; c++) {
    var cb = combos[c];
    if (cb.hasAttribute(FIELD) || !shown(cb) || cb.getAttribute('aria-disabled') === 'true' || cb.disabled) continue;
    if (cb.querySelector('input, select, textarea')) continue;
    var clab = labelElFor(cb);
    var cf = push(base(cb, 'combobox', clab), cb);
    cf.type = 'combobox-button';
    (parentC(cb) || cb).setAttribute(CONT, String(cf.idx));
    var shownText = clean(cb.textContent);
    cf.value = shownText.slice(0, 200);
    cf.hasValue = !!shownText && !PLACEHOLDER_RE.test(shownText) && shownText !== clean(clab.text);
  }

  // Button-style yes/no questions (Ashby and similar).
  var buttons = deepAll(root, 'button', []);
  var seenGroups = [];
  for (var b = 0; b < buttons.length; b++) {
    var btn = buttons[b];
    if (clean(btn.textContent).toLowerCase() !== 'yes' || !shown(btn)) continue;
    var parent = btn.closest('.ashby-application-form-input-yesno, [class*="yesno"]') || btn.parentElement;
    if (!parent || seenGroups.indexOf(parent) >= 0 || parent.hasAttribute(FIELD)) continue;
    var opts = Array.prototype.filter.call(parent.querySelectorAll('button'), function (x) { return /^(yes|no)$/i.test(clean(x.textContent)); });
    if (opts.length !== 2) continue;
    seenGroups.push(parent);
    var h = headingFor(parent);
    var ylab = h ? { text: textOf(h), els: [h] } : { text: clean(parent.getAttribute('aria-label') || ''), els: [] };
    var yf = base(parent, 'yesno', ylab);
    yf.type = 'yesno';
    yf.required = isRequired(parent, ylab);
    opts.forEach(function (x, k) {
      x.setAttribute(OPT, String(k));
      yf.options.push(clean(x.textContent));
      if (x.getAttribute('aria-pressed') === 'true' || /(^|[\s_-])(active|selected|checked)/i.test(x.className || '')) yf.hasValue = true;
    });
    push(yf, parent);
  }

  return fields.map(function (f) { var c = Object.assign({}, f); delete c.inputs; return c; });
})`;

/** Facts about the page used by detectBlockers (pure decision logic lives in detect.ts). */
export interface PageFacts {
  url: string;
  title: string;
  text: string;
  captchaVisible: string[];
  captchaPassive: string[];
  passwordFields: number;
  hasFormControls: number;
  /** Visible "Sign in" / "Create account" style buttons and links (short texts). */
  authButtons?: string[];
  /** File inputs anywhere on the page (application forms nearly always have one). */
  fileInputs?: number;
  /** Signs of an account-wall ATS (Workday automation ids, iCIMS/Taleo/SuccessFactors frames...). */
  accountWallMarkers?: string[];
}

/** Collects PageFacts from the current document. Call as `(${PAGE_FACTS_JS})()`. */
export const PAGE_FACTS_JS = String.raw`(function () {
  ${DOM_HELPERS}
  function shown(el) {
    if (!el) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    var r = el.getBoundingClientRect();
    return r.width >= 40 && r.height >= 40;
  }
  function visibleAtAll(el) { return typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true }); }
  function describe(el) {
    var src = el.getAttribute('src') || '';
    var title = el.getAttribute('title') || '';
    return (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).filter(Boolean).join('.') : '') + (src ? '[' + src.slice(0, 80) + ']' : '') + (title ? '[title=' + title.slice(0, 60) + ']' : ''));
  }
  var SEL = [
    '.h-captcha', '.g-recaptcha', '.cf-turnstile', '[data-sitekey]', '#arkose', '#arkoseFrame', '[id*="arkose"]', '#FunCaptcha',
    'iframe[src*="hcaptcha.com"]', 'iframe[src*="recaptcha"]', 'iframe[src*="challenges.cloudflare.com"]', 'iframe[src*="arkoselabs"]',
    'iframe[src*="funcaptcha"]', 'iframe[title*="hCaptcha" i]', 'iframe[title*="reCAPTCHA" i]',
    'iframe[src*="captcha-delivery.com"]', 'iframe[title*="DataDome" i]', '#px-captcha', 'iframe[src*="geetest"]', '.geetest_holder',
    'iframe[title*="Cloudflare security challenge" i]', '#challenge-stage', '#cf-challenge-running', 'iframe[src*="awswaf"]',
    '.frc-captcha', 'iframe[src*="friendlycaptcha"]',
  ].join(',');
  var HARD = /arkose|funcaptcha|captcha-delivery|datadome|px-captcha|geetest|challenge-stage|cf-challenge/i;
  var visible = [], passive = [];
  deepAll(document, SEL, []).forEach(function (el) {
    var src = (el.getAttribute('src') || '').toLowerCase();
    var d = describe(el);
    var hard = HARD.test(d);
    var invisibleHint = el.getAttribute('data-size') === 'invisible' || /size=invisible|checkbox-invisible/.test(src) || !!el.closest('.grecaptcha-badge');
    if ((hard && visibleAtAll(el)) || (!invisibleHint && shown(el))) visible.push(d);
    else passive.push(d);
  });
  var text = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 20000);
  var pw = deepAll(document, 'input[type="password"]', []).filter(visibleAtAll).length;
  var controls = deepAll(document, 'input:not([type="hidden"]), select, textarea', []).filter(function (el) {
    return typeof el.checkVisibility !== 'function' || el.checkVisibility();
  }).length;
  var files = deepAll(document, 'input[type="file"]', []).length;
  var auth = [];
  deepAll(document, 'a, button, [role="button"], input[type="submit"], input[type="button"]', []).forEach(function (el) {
    if (auth.length >= 12 || !visibleAtAll(el)) return;
    var t = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 40) return;
    if (/^(sign ?in|log ?in|login|create (an |your )?(candidate )?account|register|sign ?up|new (user|candidate)|candidate (sign ?in|log ?in))\b/i.test(t)) auth.push(t);
  });
  var markers = [];
  if (document.querySelector('[data-automation-id="signInLink"], [data-automation-id="createAccountLink"], [data-automation-id="utilityButtonSignIn"], [data-automation-id="signInSubmitButton"], [data-automation-id="createAccountSubmitButton"]')) markers.push('Workday sign-in');
  var WALL_HOSTS = /myworkdayjobs\.com|myworkday\.com|\.icims\.com|taleo\.net|successfactors\.(com|eu)|oraclecloud\.com\/hcmui|brassring\.com|workforcenow\.adp\.com/i;
  document.querySelectorAll('iframe[src], form[action]').forEach(function (el) {
    var u = el.getAttribute('src') || el.getAttribute('action') || '';
    if (WALL_HOSTS.test(u) && markers.length < 5) markers.push((el.tagName.toLowerCase()) + ' → ' + u.slice(0, 80));
  });
  return {
    url: location.href, title: document.title || '', text: text, captchaVisible: visible, captchaPassive: passive,
    passwordFields: pw, hasFormControls: controls, authButtons: auth, fileInputs: files, accountWallMarkers: markers,
  };
})`;

/** Visible validation errors after a submit attempt. Call as `(${VALIDATION_ERRORS_JS})()`. */
export const VALIDATION_ERRORS_JS = String.raw`(function () {
  ${DOM_HELPERS}
  function shown(el) { return typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true }); }
  var out = [];
  var sel = '.ashby-application-form-failure-container, .error-message, .helper-text--error, [class*="error-message"], [class*="field-error"], [role="alert"], [id$="-error"], [class*="errorMessage"], [class*="invalid-feedback"]';
  deepAll(document, sel, []).forEach(function (el) {
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t && shown(el) && out.indexOf(t) < 0) out.push(t.slice(0, 200));
  });
  deepAll(document, '[aria-invalid="true"]', []).forEach(function (el) {
    if (!shown(el)) return;
    var label = el.getAttribute('aria-label') || el.getAttribute('name') || el.id || 'field';
    var t = 'invalid: ' + label;
    if (out.indexOf(t) < 0) out.push(t.slice(0, 200));
  });
  return out.slice(0, 20);
})`;

/** Finds an embedded ATS iframe (company career sites embedding Greenhouse/Lever/Ashby/SmartRecruiters/Workable...). */
export const EMBEDDED_ATS_JS = String.raw`(function () {
  var f = document.querySelector([
    'iframe#grnhse_iframe', 'iframe[src*="greenhouse.io"]', 'iframe[src*="jobs.lever.co"]', 'iframe[src*="ashbyhq.com"]',
    'iframe[src*="smartrecruiters.com"]', 'iframe[src*="apply.workable.com"]', 'iframe[src*=".teamtailor.com"]',
    'iframe[src*="jobs.personio."]', 'iframe[src*=".recruitee.com"]', 'iframe[src*=".bamboohr.com/careers"]',
    'iframe[src*="myworkdayjobs.com"]', 'iframe[src*=".icims.com"]', 'iframe[src*="taleo.net"]', 'iframe[src*="successfactors"]'
  ].join(','));
  return f ? f.src : null;
})`;

/** ATS fingerprints for career sites on a company's own domain. Returns a SiteKind or null. */
export const SITE_MARKERS_JS = String.raw`(function () {
  function has(sel) { try { return !!document.querySelector(sel); } catch (e) { return false; } }
  if (has('script[src*="teamtailor-cdn.com"], link[href*="teamtailor-cdn.com"], [data-controller*="careersite--"]')) return 'teamtailor';
  if (has('#offer-application-form, script[src*="/js/PublicApp/"]')) return 'recruitee';
  if (has('script[src*="assets.cdn.personio.de"], form[class*="DynamicForm_formContainer"]')) return 'personio';
  if (has('form[data-ui="application-form"], script[src*="workable"][src*="candidate"]')) return 'workable';
  if (has('[data-automation-id="jobPostingHeader"], [data-automation-id="adventureButton"]')) return 'workday';
  if (has('link[href*="rmkcdn.successfactors.com"], script[src*="successfactors"]')) return 'successfactors';
  if (has('iframe#icims_content_iframe, [class*="iCIMS_"]')) return 'icims';
  if (has('script[src*="taleo.net"], form[action*="taleo"]')) return 'taleo';
  return null;
})`;

/**
 * Picks the element that holds the application form on an arbitrary page: an open modal with
 * fields, else the form with the most application-like controls, else <main>. Tags it with
 * ROOT_ATTR and returns a selector for it (null = whole page). Call as `(${PICK_FORM_ROOT_JS})()`.
 */
export const PICK_FORM_ROOT_JS = String.raw`(function () {
  ${DOM_HELPERS}
  var ATTR = 'data-pursuit-root';
  document.querySelectorAll('[' + ATTR + ']').forEach(function (el) { el.removeAttribute(ATTR); });
  function shown(el) { return typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true }); }
  function score(el) {
    var s = 0, fields = 0, emails = 0, files = 0, search = 0;
    deepAll(el, 'input, select, textarea', []).forEach(function (c) {
      var t = (c.getAttribute('type') || c.tagName).toLowerCase();
      if (/^(hidden|submit|button|reset|image)$/.test(t)) return;
      if (t === 'file') { files++; s += 5; return; }
      if (!shown(c)) return;
      if (t === 'search' || /search/i.test(c.getAttribute('name') || '') || /search/i.test(c.getAttribute('placeholder') || '')) { search++; return; }
      fields++;
      s += 1;
      if (t === 'email' || /e-?mail/i.test(c.getAttribute('name') || c.id || '')) { emails++; s += 3; }
      if (c.tagName === 'TEXTAREA') s += 2;
    });
    if (fields + files === 0) return 0;
    if (files === 0 && fields <= 2 && emails <= 1 && /subscribe|newsletter|job alert/i.test(el.textContent || '')) return 0;
    return s;
  }
  var best = null, bestScore = 0;
  var dialogs = deepAll(document, 'dialog[open], [role="dialog"], [aria-modal="true"]', []).filter(shown);
  for (var i = 0; i < dialogs.length; i++) {
    var ds = score(dialogs[i]);
    if (ds >= 2 && ds > bestScore) { best = dialogs[i]; bestScore = ds + 1000; }
  }
  if (!best) {
    var forms = deepAll(document, 'form', []).filter(shown);
    for (var j = 0; j < forms.length; j++) {
      var fs = score(forms[j]);
      if (fs > bestScore) { best = forms[j]; bestScore = fs; }
    }
    if (best && bestScore < 2) best = null;
  }
  if (!best) best = document.querySelector('main, [role="main"]');
  if (!best || !best.setAttribute) return null;
  if (best.getRootNode && best.getRootNode() !== document) return null;
  best.setAttribute(ATTR, '1');
  return '[' + ATTR + '="1"]';
})`;

/**
 * Score of the most application-like form on the page (0 = none; newsletter and search boxes score 0).
 * A file input is worth 5, an email field 4, other visible fields 1. Call as `(${BEST_FORM_SCORE_JS})()`.
 */
export const BEST_FORM_SCORE_JS = String.raw`(function () {
  ${DOM_HELPERS}
  function shown(el) { return typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true }); }
  function score(el) {
    var s = 0, fields = 0, emails = 0, files = 0;
    deepAll(el, 'input, select, textarea', []).forEach(function (c) {
      var t = (c.getAttribute('type') || c.tagName).toLowerCase();
      if (/^(hidden|submit|button|reset|image)$/.test(t)) return;
      if (t === 'file') { files++; s += 5; return; }
      if (!shown(c)) return;
      if (t === 'search' || /search/i.test(c.getAttribute('name') || '') || /search/i.test(c.getAttribute('placeholder') || '')) return;
      fields++; s += 1;
      if (t === 'email' || /e-?mail/i.test(c.getAttribute('name') || c.id || '')) { emails++; s += 3; }
    });
    if (files === 0 && fields <= 2 && emails <= 1 && /subscribe|newsletter|job alert/i.test(el.textContent || '')) return 0;
    return s;
  }
  var best = 0;
  deepAll(document, 'form, dialog[open], [role="dialog"], [aria-modal="true"]', []).filter(shown).forEach(function (f) { best = Math.max(best, score(f)); });
  if (!best) {
    var loose = document.createElement('div');
    best = score(document.querySelector('main, [role="main"]') || document.body);
  }
  return best;
})`;

/** A cheap fingerprint of the visible step (URL + visible field names + headings) to tell steps apart. */
export const STEP_SIGNATURE_JS = String.raw`(function () {
  ${DOM_HELPERS}
  function shown(el) { return typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true }); }
  var parts = [location.pathname + location.search + location.hash];
  deepAll(document, 'input:not([type="hidden"]), select, textarea', []).forEach(function (c) {
    if (shown(c)) parts.push((c.getAttribute('name') || c.id || c.getAttribute('aria-label') || c.type || '').slice(0, 60));
  });
  deepAll(document, 'h1, h2, h3, legend', []).forEach(function (h) { if (shown(h)) parts.push((h.textContent || '').trim().slice(0, 60)); });
  return parts.join('|').slice(0, 4000);
})`;
