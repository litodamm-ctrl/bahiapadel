const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const filename = path.join(root, 'index.html');
let html = fs.readFileSync(filename, 'utf8');

// Keep the large legacy booking screen intact. Include the isolated editor at build time.
const marker = '<script src="/client-editor.js?v=20260918-1" defer></script>';
if (!html.includes(marker)) {
  if (!html.includes('</body>') || !html.includes('id="tabsNav"')) throw new Error('Manager layout changed: review the client editor integration');
  html = html.replace('</body>', marker + '\n</body>');
}

// Directory writes originating in booking forms must not overwrite a concurrent
// profile update or a different receptionist's newly created client list.
const start = html.indexOf('async function upsertClient(');
const end = html.indexOf('\nasync function loadDateData()', start);
if (start < 0 || end < start) throw new Error('Client persistence hook not found');
html = html.slice(0, start) + `async function upsertClient(nombre, apellido, phone, email){
  if(!phone) return;
  const normalizar = value => {
    let digits=String(value||'').replace(/\\D/g,'');
    if(digits.startsWith('00')) digits=digits.slice(2);
    if(/^3\\d{9}$/.test(digits)) digits='57'+digits;
    return digits;
  };
  const number=normalizar(phone);
  for(let attempt=0;attempt<3;attempt++){
    const stored=await window.storage.get('clientes-directorio',true);
    const list=stored?JSON.parse(stored.value):[];
    if(!Array.isArray(list)) throw new Error('No se pudo leer el directorio de clientes');
    const idx=list.findIndex(c=>normalizar(c.phone)===number);
    const record={...(idx>=0?list[idx]:{}),nombre,apellido,phone:number,email};
    if(idx>=0 && JSON.stringify(list[idx])===JSON.stringify(record)){state.clients=list;return;}
    if(idx>=0) list[idx]=record; else list.push(record);
    try{
      await window.storage.set('clientes-directorio',JSON.stringify(list),true,stored?(stored.version||0):0);
      state.clients=list;
      return;
    }catch(error){if(!error.conflicto || attempt===2) throw error;}
  }
}
` + html.slice(end);

// Fail the build on syntax errors rather than publish a broken reception screen.
for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
  if (script[1].trim()) new vm.Script(script[1]);
}
new vm.Script(fs.readFileSync(path.join(root, 'client-editor.js'), 'utf8'));
fs.writeFileSync(filename, html);
console.log('Client editor integrated; manager scripts validated.');
