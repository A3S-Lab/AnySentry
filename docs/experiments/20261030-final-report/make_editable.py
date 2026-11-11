"""Add a standalone, offline report editor; no external dependencies or uploads."""

STYLE = r'''<style id="report-editor-style">
#report-editor{position:sticky;top:0;z-index:10;display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 14px;background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 2px 8px #0f172a0d;margin-bottom:20px;font-size:14px}
#report-editor button{font:inherit;min-height:44px;padding:8px 14px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#1f2937;cursor:pointer}
#report-editor #report-save{background:#155e75;color:white;border-color:#155e75}
#report-editor button:hover{filter:brightness(.95)}#report-editor button:focus-visible{outline:3px solid #0284c7;outline-offset:2px}#report-editor button:disabled{opacity:.6;cursor:wait}
#report-editor-status{flex:1;min-width:200px;color:#475569;font-size:13px}
#report-content[contenteditable=true]:focus{outline:2px solid #7dd3fc;outline-offset:6px}
#report-content[contenteditable=true] td:focus-within{background:#f0f9ff}
@media print{#report-editor{display:none!important}#report-content{outline:none!important}body{margin:0;max-width:none}}
</style>'''

TOOLBAR = '''<div id="report-editor" role="region" aria-label="报告编辑工具栏">
<strong>报告编辑</strong>
<button type="button" id="report-toggle" aria-pressed="true">退出编辑</button>
<button type="button" id="report-save">保存 HTML</button>
<button type="button" id="report-download">导出副本</button>
<span id="report-editor-status" role="status" aria-live="polite">点击文字或表格即可编辑；Ctrl / ⌘ + S 保存 HTML。</span>
</div>'''

SCRIPT = r'''<script id="report-editor-script">
(() => {
  'use strict';
  const report = document.getElementById('report-content');
  const status = document.getElementById('report-editor-status');
  const toggle = document.getElementById('report-toggle');
  const saveButton = document.getElementById('report-save');
  let fileHandle = null;
  let draftTimer;
  let saving = false;
  let draftAvailable = true;
  // A rebuilt report gets a different draft key, preventing an old draft hiding new results.
  const original = report.innerHTML;
  let hash = 2166136261;
  for (let i = 0; i < original.length; i++) hash = Math.imul(hash ^ original.charCodeAt(i), 16777619);
  const draftKey = 'anysentry-report-draft-v1:' + location.pathname + ':' + (hash >>> 0);
  function draft() {
    try {
      localStorage.setItem(draftKey, JSON.stringify({html: report.innerHTML, at: Date.now()}));
      return true;
    } catch (_) { draftAvailable = false; return false; }
  }
  try {
    const stored = JSON.parse(localStorage.getItem(draftKey) || 'null');
    if (stored && typeof stored.html === 'string') {
      report.innerHTML = stored.html;
      status.textContent = '已恢复本浏览器草稿；点击“保存 HTML”写出修改后的文件。';
    }
  } catch (_) { draftAvailable = false; }
  function changed() {
    clearTimeout(draftTimer);
    status.textContent = '有未写入 HTML 文件的修改…';
    draftTimer = setTimeout(() => {
      status.textContent = draft()
        ? '草稿已暂存于本浏览器；点击“保存 HTML”写出文件。'
        : '浏览器无法暂存草稿，请点击“保存 HTML”保存文件。';
    }, 500);
  }
  report.addEventListener('input', changed);
  // Paste plain text, preserving the existing table and avoiding pasted HTML/scripts.
  report.addEventListener('paste', event => {
    if (report.getAttribute('contenteditable') !== 'true' || !event.clipboardData) return;
    event.preventDefault();
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    changed();
  });
  toggle.addEventListener('click', () => {
    const enabled = report.getAttribute('contenteditable') !== 'true';
    report.setAttribute('contenteditable', String(enabled));
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.textContent = enabled ? '退出编辑' : '开启编辑';
    if (enabled) report.focus();
  });
  function filename() {
    try { return decodeURIComponent(location.pathname.split('/').pop()) || 'anysentry-report.html'; }
    catch (_) { return 'anysentry-report.html'; }
  }
  function serialize() {
    const copy = document.documentElement.cloneNode(true);
    copy.querySelector('#report-content').setAttribute('contenteditable', 'true');
    copy.querySelector('#report-toggle').setAttribute('aria-pressed', 'true');
    copy.querySelector('#report-toggle').textContent = '退出编辑';
    copy.querySelector('#report-save').removeAttribute('disabled');
    copy.querySelector('#report-editor-status').textContent = '点击文字或表格即可编辑；Ctrl / ⌘ + S 保存 HTML。';
    return '<!doctype html>' + String.fromCharCode(10) + copy.outerHTML;
  }
  function download() {
    draft();
    const url = URL.createObjectURL(new Blob([serialize()], {type: 'text/html;charset=utf-8'}));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename();
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    status.textContent = '已导出修改后的 HTML 副本；下载不会自动覆盖原文件。';
  }
  async function save() {
    if (saving) return;
    saving = true;
    saveButton.disabled = true;
    clearTimeout(draftTimer);
    draft();
    try {
      if (!window.showSaveFilePicker) { download(); return; }
      if (!fileHandle) fileHandle = await window.showSaveFilePicker({
        suggestedName: filename(),
        types: [{description: 'HTML 报告', accept: {'text/html': ['.html']}}],
      });
      const stream = await fileHandle.createWritable();
      try { await stream.write(serialize()); await stream.close(); }
      catch (error) { try { await stream.abort(); } catch (_) {} throw error; }
      status.textContent = '已保存到所选 HTML 文件。';
    } catch (error) {
      if (error.name === 'AbortError') status.textContent = '已取消保存，页面修改仍保留。';
      else if (error.name === 'SecurityError' || error.name === 'NotSupportedError') download();
      else {
        fileHandle = null;
        status.textContent = '未能写入文件，请重试或使用“导出副本”。';
      }
    } finally { saving = false; saveButton.disabled = false; }
  }
  saveButton.addEventListener('click', save);
  document.getElementById('report-download').addEventListener('click', download);
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
  });
  if (!draftAvailable) status.textContent = '可直接编辑；本浏览器不支持草稿暂存，请用“保存 HTML”保存。';
})();
</script>'''


def make_editable(html):
    if 'id="report-editor-script"' in html:
        return html
    html = html.replace('</head>', STYLE + '\n</head>', 1)
    html = html.replace('<body>', '<body>\n' + TOOLBAR + '\n<main id="report-content" contenteditable="true" spellcheck="false" aria-label="可编辑实验报告">', 1)
    return html.replace('</body>', '</main>\n' + SCRIPT + '\n</body>', 1)


if __name__ == '__main__':
    import sys
    from pathlib import Path
    path = Path(sys.argv[1])
    path.write_text(make_editable(path.read_text()))
