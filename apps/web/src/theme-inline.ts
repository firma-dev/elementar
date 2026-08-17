/**
 * Ровно тот скрипт, что стоит инлайном в index.html (§13.2): тема ставится до первого
 * пейнта. Его sha256 попадает в CSP (§13.4), поэтому строка обязана совпадать с разметкой
 * байт в байт — это проверяется тестом. Отдельный модуль без зависимостей, чтобы тест
 * не тянул за собой всю дизайн-систему.
 */
export const THEME_INLINE_SCRIPT =
  "try{var t=localStorage.getItem('e.theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}"
