// Inline no-flash script run before paint. First copies any legacy `pal-*` /
// `pal_*` localStorage entries to their `pal-*` / `pal_*` names (never
// overwriting an existing pal key; legacy kept so a rollback still works), then
// applies the theme. Auth-token logout removes the legacy token key explicitly.
export const THEME_INIT_SCRIPT = `try{for(var i=localStorage.length-1;i>=0;i--){var k=localStorage.key(i),m=k&&k.match(/^pal([-_].*)$/);if(m&&localStorage.getItem('pal'+m[1])===null)localStorage.setItem('pal'+m[1],localStorage.getItem(k));}var t=localStorage.getItem('pal-theme')||'dark';document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='dark';}`;
