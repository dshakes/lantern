// Inline no-flash script run before paint: applies the persisted theme
// (dark by default) before the first frame.
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('pal-theme')||'dark';document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='dark';}`;
