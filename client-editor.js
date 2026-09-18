/* Client editing uses the existing staff session. No public client data or keys. */
(function () {
  'use strict';
  if (window.__bahiaClientEditor) return;
  window.__bahiaClientEditor = true;
  let dialog = null, clients = [], selected = null, query = '', saving = false, notice = '';
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const searchText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const phone = value => {
    let n = String(value || '').replace(/\D/g, '');
    if (n.startsWith('00')) n = n.slice(2);
    return /^3\d{9}$/.test(n) ? '57' + n : n;
  };
  const unlocked = () => typeof state !== 'undefined' && state.appUnlocked;
  const byId = id => dialog && dialog.querySelector('#' + id);
  const style = document.createElement('style');
  style.textContent = `
    #client-manager-dialog{width:min(780px,94vw);max-height:90vh;padding:0;border:1px solid #cbd9d7;border-radius:18px;color:#14282B;background:#fff;font-family:inherit;box-shadow:0 24px 80px #0004}
    #client-manager-dialog::backdrop{background:#0E3B4388}
    #client-manager-dialog .cm-header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:20px 24px;background:#0E3B43;color:#fff}
    #client-manager-dialog h2{font-family:var(--font-display,inherit);font-size:28px;letter-spacing:.4px;margin:0;color:inherit}
    #client-manager-dialog .cm-body{padding:22px 24px}
    #client-manager-dialog .cm-sub{font-size:13px;line-height:1.6;color:#4B6167;margin:0 0 18px}
    #client-manager-dialog .cm-close{border:1px solid #ffffff60;background:none;color:#fff;padding:8px 12px;border-radius:9px;min-height:42px;font:inherit}
    #client-manager-dialog .cm-tools{display:flex;gap:10px;align-items:end;margin-bottom:12px}
    #client-manager-dialog .cm-tools label{flex:1}
    #client-manager-dialog label{display:block;font-size:13px;font-weight:600;color:#4B6167}
    #client-manager-dialog input{display:block;box-sizing:border-box;width:100%;padding:11px 12px;margin-top:6px;border:1.5px solid #cbd9d7;border-radius:9px;font:inherit;font-weight:400;color:#14282B;background:#fff;min-height:44px}
    #client-manager-dialog input:focus-visible,#client-manager-dialog button:focus-visible{outline:2px solid #FF6A4D;outline-offset:2px}
    #client-manager-dialog .cm-button{border:1px solid #1F9E92;border-radius:9px;min-height:44px;padding:9px 14px;background:#fff;color:#0E3B43;font:inherit;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap}
    #client-manager-dialog .cm-primary{background:#1F9E92;color:#fff}
    #client-manager-dialog button:disabled{opacity:.55;cursor:wait}
    #client-manager-dialog .cm-count{font-size:12px;color:#4B6167;margin:12px 0}
    #client-manager-dialog .cm-table{width:100%;border-collapse:collapse;font-size:14px}
    #client-manager-dialog .cm-table th{text-align:left;background:#FAF5E8;color:#4B6167;font-size:12px;padding:11px 10px}
    #client-manager-dialog .cm-table td{padding:12px 10px;border-bottom:1px solid #e4ebe9;vertical-align:middle;overflow-wrap:anywhere}
    #client-manager-dialog .cm-table td:last-child{text-align:right;width:80px}
    #client-manager-dialog .cm-contact{display:block;font-size:12px;color:#4B6167;margin-top:4px;overflow-wrap:anywhere}
    #client-manager-dialog .cm-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:16px 0}
    #client-manager-dialog .cm-help{font-size:12px;line-height:1.6;color:#4B6167;margin:8px 0 18px}
    #client-manager-dialog .cm-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
    #client-manager-dialog .cm-alert{padding:12px 14px;border-radius:9px;font-size:13px;line-height:1.5;margin-bottom:16px;background:#FBE7E2;color:#873522}
    #client-manager-dialog .cm-success{background:#E4F5EC;color:#1b6348}
    #client-manager-dialog .cm-empty{padding:28px 10px;text-align:center;color:#4B6167;font-size:14px}
    @media(max-width:540px){#client-manager-dialog .cm-body{padding:18px 15px}#client-manager-dialog .cm-header{padding:16px}#client-manager-dialog .cm-grid{grid-template-columns:1fr;gap:14px}#client-manager-dialog .cm-tools{align-items:stretch;flex-direction:column}#client-manager-dialog .cm-table th,#client-manager-dialog .cm-table td{padding:10px 5px}#client-manager-dialog .cm-actions{flex-wrap:wrap}}
  `;
  document.head.appendChild(style);

  function dirty() {
    if (!selected || !byId('cm-name')) return false;
    return byId('cm-name').value !== String(selected.nombre || '') || byId('cm-lastname').value !== String(selected.apellido || '') || byId('cm-phone').value !== String(selected.phone || '') || byId('cm-email').value !== String(selected.email || '');
  }
  function close(force) {
    if (saving && !force) return;
    if (!force && dirty() && !window.confirm('Hay cambios sin guardar. ¿Quieres salir sin guardarlos?')) return;
    if (dialog) { dialog.close(); dialog.remove(); dialog = null; }
    selected = null;
  }
  function shell(title) {
    dialog.innerHTML = '<div class="cm-header"><h2 id="cm-title">' + escape(title) + '</h2><button type="button" id="cm-close" class="cm-close" aria-label="Cerrar clientes">Cerrar</button></div><div class="cm-body" id="cm-body"></div>';
    byId('cm-close').addEventListener('click', () => close(false));
  }
  function error(message) {
    const box = byId('cm-error');
    if (box) { box.hidden = false; box.textContent = message; box.focus(); }
  }
  async function readDirectory() {
    const result = await window.storage.get('clientes-directorio', true);
    const list = result ? JSON.parse(result.value) : [];
    if (!Array.isArray(list)) throw new Error('El directorio no tiene un formato válido');
    clients = list;
    if (typeof state !== 'undefined') state.clients = list;
  }
  async function refresh() {
    const button = byId('cm-refresh');
    if (button) button.disabled = true;
    try { await readDirectory(); selected = null; renderList(); }
    catch (e) { error(e.noAuth ? 'Tu sesión venció. Cierra esta ventana e ingresa nuevamente.' : 'No se pudo cargar el directorio. Intenta actualizar nuevamente.'); }
    finally { if (button && button.isConnected) button.disabled = false; }
  }
  async function open() {
    if (!unlocked()) return;
    if (dialog) { dialog.focus(); return; }
    dialog = document.createElement('dialog');
    dialog.id = 'client-manager-dialog';
    dialog.setAttribute('aria-labelledby', 'cm-title');
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(false); });
    document.body.appendChild(dialog);
    selected = null; notice = '';
    renderList();
    dialog.showModal();
    byId('cm-rows').innerHTML = '<tr><td colspan="3" class="cm-empty">Cargando clientes…</td></tr>';
    await refresh();
  }
  function renderList() {
    if (!dialog) return;
    shell('Clientes');
    byId('cm-body').innerHTML = '<p class="cm-sub">Busca un cliente y actualiza sus datos de contacto. Sus reservas, pagos y premios se conservan.</p>' +
      (notice ? '<div class="cm-alert cm-success" role="status">' + escape(notice) + '</div>' : '') +
      '<div id="cm-error" class="cm-alert" role="alert" tabindex="-1" hidden></div><div class="cm-tools"><label>Buscar por nombre, teléfono o correo<input id="cm-search" type="search" autocomplete="off" placeholder="Nombre, teléfono o correo" value="' + escape(query) + '"></label><button type="button" class="cm-button" id="cm-refresh">Actualizar lista</button></div><p class="cm-count" id="cm-count" aria-live="polite"></p><table class="cm-table"><thead><tr><th>Cliente</th><th>Contacto</th><th>Acción</th></tr></thead><tbody id="cm-rows"></tbody></table>';
    byId('cm-search').addEventListener('input', event => { query = event.target.value; renderRows(); });
    byId('cm-refresh').addEventListener('click', refresh);
    renderRows();
    byId('cm-search').focus();
  }
  function renderRows() {
    const needle = searchText(query.trim());
    const found = clients.map((client, index) => ({ client, index })).filter(({ client }) => searchText([client.nombre, client.apellido, client.phone, client.email].join(' ')).includes(needle));
    const shown = found.slice(0, 100);
    byId('cm-count').textContent = found.length + ' cliente(s)' + (found.length > 100 ? ' · Se muestran los primeros 100. Escribe para afinar la búsqueda.' : '') + ' · ' + clients.length + ' en el directorio';
    byId('cm-rows').innerHTML = shown.length ? shown.map(({ client, index }) => '<tr><td><strong>' + escape([client.nombre, client.apellido].filter(Boolean).join(' ') || 'Sin nombre') + '</strong></td><td>' + escape(client.phone || 'Sin teléfono') + '<span class="cm-contact">' + escape(client.email || 'Sin correo') + '</span></td><td><button type="button" class="cm-button" data-client-index="' + index + '" aria-label="Editar datos de ' + escape([client.nombre, client.apellido].filter(Boolean).join(' ')) + '">Editar</button></td></tr>').join('') : '<tr><td colspan="3" class="cm-empty">No se encontraron clientes con esa búsqueda.</td></tr>';
    byId('cm-rows').querySelectorAll('[data-client-index]').forEach(button => button.addEventListener('click', () => edit(clients[Number(button.dataset.clientIndex)])));
  }
  function edit(client) {
    selected = JSON.parse(JSON.stringify(client));
    notice = '';
    shell('Actualizar datos del cliente');
    byId('cm-body').innerHTML = '<p class="cm-sub">Modifica los datos y guarda los cambios. No se cambiarán los horarios, los precios ni los pagos de sus reservas.</p><div id="cm-error" class="cm-alert" role="alert" tabindex="-1" hidden></div><form id="cm-form"><div class="cm-grid"><label>Nombre *<input id="cm-name" name="nombre" required maxlength="100" autocomplete="given-name" value="' + escape(client.nombre) + '"></label><label>Apellido<input id="cm-lastname" name="apellido" maxlength="100" autocomplete="family-name" value="' + escape(client.apellido) + '"></label><label>Teléfono / WhatsApp *<input id="cm-phone" name="phone" required maxlength="30" type="tel" autocomplete="tel" value="' + escape(client.phone) + '"></label><label>Correo electrónico<input id="cm-email" name="email" maxlength="254" type="email" autocomplete="email" value="' + escape(client.email) + '"></label></div><p class="cm-help">Para Colombia puedes escribir los 10 dígitos del celular; se agrega el indicativo 57. Para otros países incluye su indicativo. Si cambias el teléfono, se trasladará el vínculo de sus reservas y premios; no se fusionarán registros de otras personas.</p><div class="cm-actions"><button class="cm-button" type="button" id="cm-back">Volver a clientes</button><button class="cm-button cm-primary" type="submit" id="cm-save">Guardar cambios</button></div></form>';
    byId('cm-back').addEventListener('click', () => {
      if (saving) return;
      if (dirty() && !window.confirm('Hay cambios sin guardar. ¿Quieres volver sin guardarlos?')) return;
      selected = null; renderList();
    });
    byId('cm-form').addEventListener('submit', save);
    byId('cm-name').focus();
  }
  async function save(event) {
    event.preventDefault();
    if (saving || !selected) return;
    const client = { nombre: byId('cm-name').value.trim(), apellido: byId('cm-lastname').value.trim(), phone: phone(byId('cm-phone').value), email: byId('cm-email').value.trim().toLowerCase() };
    if (!client.nombre || !/^[1-9]\d{7,14}$/.test(client.phone) || /^(\d)\1+$/.test(client.phone)) { error('Revisa el nombre y escribe un teléfono válido con indicativo de país.'); return; }
    if (phone(selected.phone) !== client.phone && !window.confirm('¿Confirmas el cambio de teléfono a ' + client.phone + '? Se mantendrán vinculadas las reservas y los premios de este cliente.')) return;
    saving = true;
    byId('cm-error').hidden = true;
    byId('cm-save').textContent = 'Guardando…';
    dialog.querySelectorAll('input,button').forEach(control => { control.disabled = true; });
    try {
      const response = await fetch('/.netlify/functions/clientes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(25000),
        body: JSON.stringify({ action: 'update', code: window.__appCode || '', token: window.__appToken || '', original: selected, client, staffName: typeof state !== 'undefined' ? state.staffName : 'Staff' })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'No se pudo confirmar el guardado.');
      selected = null;
      notice = 'Datos guardados. Las reservas, los pagos y los premios del cliente se conservaron.';
      try {
        await readDirectory();
        if (typeof loadDateData === 'function') await loadDateData();
      } catch (_) { notice += ' Actualiza la lista para ver la información más reciente.'; }
      renderList();
    } catch (e) {
      error(e.name === 'TimeoutError' || e.name === 'AbortError' ? 'No se pudo confirmar el guardado. Vuelve a la lista y actualízala antes de intentar nuevamente.' : e.message || 'Error de conexión. Actualiza la lista antes de reintentar.');
    } finally {
      saving = false;
      if (dialog) {
        dialog.querySelectorAll('input,button').forEach(control => { control.disabled = false; });
        if (byId('cm-save')) byId('cm-save').textContent = 'Guardar cambios';
      }
    }
  }
  function attach() {
    const existing = document.getElementById('clients-manager-button');
    if (!unlocked()) { if (existing) existing.remove(); if (dialog) close(true); return; }
    const nav = document.getElementById('tabsNav');
    if (!nav || existing) return;
    const button = document.createElement('button');
    button.id = 'clients-manager-button'; button.type = 'button'; button.className = 'tab-btn'; button.textContent = 'Clientes';
    button.addEventListener('click', open);
    nav.insertBefore(button, nav.querySelector('.lock-btn'));
  }
  new MutationObserver(attach).observe(document.body, { childList: true, subtree: true });
  attach();
})();
