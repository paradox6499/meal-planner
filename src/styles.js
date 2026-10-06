// Общие стили приложения: шрифт, акцентные цвета, «стекло» и объект styles.

// ---------- styles ----------
// Liquid Glass: полупрозрачные слои с backdrop-filter поверх мягкого
// градиентного фона, тонкие hairline-обводки вместо жёстких рамок, системный
// шрифт Apple вместо декоративных веб-шрифтов, всё скруглено и "парит".

export const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif";

// Цвета читаются из CSS-переменных (см. <style> в JSX), а не хардкожены —
// так работает автоматическая тёмная тема через prefers-color-scheme, без
// какого-либо JS-состояния или переключателя.
export const ACCENT = "var(--accent)";

export const DANGER = "var(--danger)";

export const glass = (opacity = 0.55, blur = 20) => ({
  background: `rgba(var(--glass-rgb), ${opacity})`,
  backdropFilter: `blur(${blur}px) saturate(180%)`,
  WebkitBackdropFilter: `blur(${blur}px) saturate(180%)`,
});

export const styles = {
  page: {
    minHeight: "100dvh", width: "100%", display: "flex", justifyContent: "center", alignItems: "flex-start",
    background: "var(--page-bg)",
    padding: "40px 16px", fontFamily: FONT, color: "var(--text-primary)",
  },
  // will-change держит карточку на собственном GPU-слое постоянно (не
  // только в момент форсированного reflow из useEffect выше) — вторая,
  // более "фоновая" защита от той же WebView-проблемы с зависшим кадром.
  card: { width: "100%", maxWidth: 440, ...glass(0.55, 24), borderRadius: 28, border: "1px solid var(--hairline)", padding: 26, boxShadow: "var(--card-shadow)", willChange: "transform" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
  brandRow: { display: "flex", alignItems: "center", gap: 9 },
  logoMark: {
    width: 32, height: 32, borderRadius: 9, flexShrink: 0, objectFit: "cover",
    boxShadow: "0 3px 10px rgba(0,0,0,0.25)",
  },
  brand: { fontSize: 19, fontWeight: 700, letterSpacing: "-0.015em" },
  // marginLeft = ширина логотипа (32) + gap строки с ним (9) — раньше
  // приветствие начиналось от самого края (x=0), то есть ровно под
  // логотипом, а с учётом тени логотипа (boxShadow у logoMark) визуально
  // наезжало на неё. Теперь строка начинается под названием "Съедим", а не
  // под иконкой — логотип и текст больше не соседствуют по вертикали.
  greeting: { fontSize: 12, color: "var(--text-tertiary)", marginTop: 2, marginLeft: 41 },
  // height: 32 — та же высота, что у круглой accountBtn (шестерёнки) рядом
  // в шапке: раньше разной высоты пилюля и кружок в одном ряду выглядели
  // рассинхронизированно, хотя обе уже были "стеклянными".
  resetBtn: { display: "flex", alignItems: "center", gap: 5, height: 32, ...glass(0.5, 8), border: "1px solid var(--hairline)", borderRadius: 999, padding: "0 13px", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", cursor: "pointer" },
  // Переключатель слотов плана (см. PlanSlotsBar) — компактный ряд чипов над
  // списком покупок, тот же язык, что у storeChip/rowChip выше, но горизонтально
  // и мельче (это навигация между уже собранными планами, не выбор в визарде).
  planSlotsBar: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 },
  planSlotChip: (active) => ({
    display: "flex", alignItems: "center", gap: 6, height: 30, padding: "0 6px 0 12px", borderRadius: 999, cursor: "pointer",
    border: active ? "1.5px solid rgba(10,132,255,0.55)" : "1px solid var(--hairline)",
    ...glass(active ? 0.7 : 0.45, 8),
    fontSize: 12.5, fontWeight: 600, color: active ? ACCENT : "var(--text-secondary)",
  }),
  planSlotRemove: { display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, borderRadius: "50%", color: "var(--text-tertiary)" },
  planSlotAddChip: { display: "flex", alignItems: "center", gap: 5, height: 30, padding: "0 12px", borderRadius: 999, cursor: "pointer", border: "1px dashed var(--hairline)", background: "none", fontSize: 12.5, fontWeight: 600, color: ACCENT },
  accountBtn: { display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, ...glass(0.5, 8), border: "1px solid var(--hairline)", borderRadius: "50%", color: "var(--text-secondary)", cursor: "pointer" },
  // Раньше marginTop:10 — визуально впритык к кнопкам "назад"/"Далее" сразу
  // над ним (у них свой отступ всего 22px сверху, но снизу ничего не было).
  // Увеличил и добавил чуть паддинга — рифмуется с остальными вертикальными
  // интервалами в карточке (18-22px), а не выбивается мелким зазором.
  quickHint: { fontSize: 12, color: "var(--text-tertiary)", textAlign: "center", marginTop: 24, paddingTop: 4, lineHeight: 1.4 },
  inlineLinkBtn: { background: "none", border: "none", padding: 0, color: ACCENT, fontWeight: 600, fontSize: 12, cursor: "pointer", textDecoration: "underline" },
  legalLinkBtn: { background: "none", border: "none", padding: "12px 0", minHeight: 44, color: ACCENT, fontWeight: 600, fontSize: 13, cursor: "pointer", textDecoration: "underline", textAlign: "left" },
  // Живая жалоба в чате: "надпись Аккаунт близко к кнопке" — marginBottom
  // был всего 2px, заголовок практически прилипал к пилюле "Назад" сразу
  // над ним. 14 — тот же отступ, что у resultHeader (шапка ResultView),
  // единообразно с остальными местами, где заголовок идёт после отдельного
  // управляющего элемента.
  accountHeaderRow: { display: "flex", alignItems: "center", marginBottom: 14 },
  acctSection: { marginTop: 18 },
  acctSectionTitle: { fontSize: 15, fontWeight: 700, marginBottom: 4 },
  acctSectionHint: { fontSize: 12.5, color: "var(--text-tertiary)", lineHeight: 1.45, margin: "0 0 12px 0" },
  acctLabel: { fontSize: 12, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.02em", marginBottom: 8 },
  acctDivider: { height: 1, background: "var(--hairline)", margin: "22px 0" },
  acctClearBtn: { width: "100%", background: "none", border: "none", color: "var(--danger)", fontSize: 12.5, fontWeight: 500, cursor: "pointer", padding: "10px 0 0 0" },
  // Отдельный стиль от acctClearBtn: та кнопка красная (--danger) — уместно
  // для "Сбросить профиль" (реально необратимое действие), но не для
  // простого "Назад" здесь — переход назад ничего не удаляет и не должен
  // выглядеть тревожно. Жалоба в чате: кнопка была прижата почти вплотную к
  // "Открыть Pro" над ней (padding-top 10px у acctClearBtn) — увеличил
  // отступ и убрал ложный красный акцент.
  consentRow: { display: "flex", alignItems: "flex-start", gap: 8, marginTop: 12, fontSize: 12, lineHeight: 1.5, color: "var(--text-secondary)", textAlign: "left", cursor: "pointer" },
  consentBox: { width: 18, height: 18, marginTop: 1, flexShrink: 0, accentColor: ACCENT },
  proLinkBtn: { width: "100%", background: "none", border: "none", color: ACCENT, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: "14px 4px 0 4px", lineHeight: 1.4, textAlign: "center" },
  limitBackBtn: { width: "100%", background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 13, fontWeight: 500, cursor: "pointer", padding: "20px 0 0 0" },
  // "Купить ещё один план" — сознательно НЕ такой же заливкой, как
  // navBtnPrimary ("Открыть Pro") — более лёгкое, менее обязывающее решение
  // должно и выглядеть менее весомым, обводка вместо заливки.
  extraPlanBtn: { width: "100%", padding: "13px 0", background: "none", border: `1.5px solid ${ACCENT}`, borderRadius: 18, color: ACCENT, fontSize: 14, fontWeight: 600, cursor: "pointer", marginTop: 4 },
  acctWarnHint: { fontSize: 12, color: "var(--warning-text)", textAlign: "center", marginTop: 8 },
  homeScreenAddedRow: {
    display: "flex", alignItems: "center", gap: 10, padding: "13px 15px", borderRadius: 18,
    border: "1px solid var(--hairline)", ...glass(0.45, 12), fontSize: 13.5, fontWeight: 500, color: "var(--text-secondary)",
  },
  textInput: {
    width: "100%", padding: "12px 14px", borderRadius: 14, border: "1px solid var(--hairline)",
    ...glass(0.45, 10), color: "var(--text-primary)",
    // 16px, не 14 — Safari на iOS зумит страницу при фокусе на инпуте с
    // font-size < 16px, это его собственное поведение, не баг вёрстки; ниже
    // 16 здесь быть не должно, даже если по дизайну хочется мельче.
    fontSize: 16, fontFamily: "inherit",
  },
  mealTimeRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 15px",
    borderRadius: 18, border: "1px solid var(--hairline)", ...glass(0.45, 12), fontSize: 14, fontWeight: 500,
  },
  timeInputWrap: { position: "relative", display: "inline-flex", alignItems: "center" },
  timeInput: {
    border: "1px solid var(--hairline)", borderRadius: 10, padding: "6px 28px 6px 8px", color: "var(--text-primary)",
    background: "transparent", fontSize: 16, fontFamily: "inherit", // 16px — та же причина, что у textInput выше
  },
  // pointerEvents:"none" — иконка декоративная, клик должен пройти сквозь
  // неё на невидимый нативный picker-indicator под ней (см. CSS выше).
  timeInputIcon: { position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" },
  themeChip: (active) => ({
    flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "12px 6px", borderRadius: 16, cursor: "pointer",
    border: active ? "1.5px solid rgba(10,132,255,0.55)" : "1px solid var(--hairline)",
    ...glass(active ? 0.7 : 0.45, 12),
    boxShadow: active ? "0 4px 14px rgba(10,132,255,0.18)" : "none",
    color: active ? ACCENT : "var(--text-secondary)", fontSize: 11.5, fontWeight: 600,
  }),
  subCard: { border: "1px solid var(--hairline)", borderRadius: 20, padding: "16px 16px 18px", ...glass(0.5, 12) },
  // Строка участника семьи (см. FamilySection) — простой список имён, не
  // интерактивная (нет кнопок на строку — единственное управляющее действие
  // тут "Покинуть семью" целиком, не по одному участнику), поэтому обычный
  // текст того же веса, что и chipHint, а не rowChip-кнопка.
  familyMemberRow: { fontSize: 13, color: "var(--text-secondary)", padding: "4px 0" },
  progressCardsRow: { display: "flex", gap: 10 },
  progressCard: { flex: 1, minWidth: 0, border: "1px solid var(--hairline)", borderRadius: 16, padding: "14px 12px", ...glass(0.45, 10) },
  progressCardValue: { fontSize: 20, fontWeight: 700, marginTop: 8, letterSpacing: "-0.01em" },
  progressCardLabel: { fontSize: 11.5, color: "var(--text-tertiary)", marginTop: 2, lineHeight: 1.3 },
  freeBadge: { fontSize: 10.5, fontWeight: 700, color: "var(--text-tertiary)", background: "var(--track-bg)", padding: "2px 8px", borderRadius: 999, marginLeft: "auto" },
  proBadge: { fontSize: 10.5, fontWeight: 700, color: "#fff", background: ACCENT, padding: "2px 8px", borderRadius: 999, marginLeft: "auto" },
  historyDetail: { padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6 },
  historyDay: { display: "flex", flexDirection: "column", gap: 2, fontSize: 12.5, color: "var(--text-secondary)" },
  historyDayLabel: { fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" },
  historyDishBtn: { background: "none", border: "none", padding: 0, margin: 0, font: "inherit", color: "inherit", cursor: "pointer", textDecoration: "underline", textDecorationColor: "rgba(10,132,255,0.35)" },
  proHero: {
    width: 64, height: 64, borderRadius: 20, margin: "0 auto 14px auto", display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(10,132,255,0.12)",
  },
  proFeatureRow: { display: "flex", gap: 10, alignItems: "flex-start" },
  proFeatureCheck: {
    width: 22, height: 22, borderRadius: "50%", flexShrink: 0, marginTop: 1, display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(10,132,255,0.12)",
  },
  proPriceBox: { marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--hairline)" },
  proPriceRow: { display: "flex", alignItems: "baseline", justifyContent: "center", gap: 8 },
  proPriceNew: { fontSize: 28, fontWeight: 700, letterSpacing: "-0.01em" },
  proPricePeriod: { fontSize: 13, color: "var(--text-tertiary)" },
  progressWrap: { marginBottom: 22 },
  progressSegments: { display: "flex", gap: 4 },
  progressSegment: (filled) => ({
    flex: 1, height: 5, borderRadius: 999,
    background: filled ? `linear-gradient(90deg, ${ACCENT}, var(--accent-2))` : "var(--track-bg)",
    transition: "background .25s ease",
  }),
  progressLabel: { fontSize: 12, fontWeight: 500, color: "var(--text-tertiary)", marginTop: 8 },
  stepBody: { minHeight: 260, display: "flex", flexDirection: "column" },
  stepIcon: { width: 40, height: 40, borderRadius: 14, background: "rgba(10,132,255,0.12)", color: ACCENT, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 14 },
  stepTitle: { fontSize: 21, fontWeight: 700, letterSpacing: "-0.01em", margin: "0 0 4px 0" },
  stepSub: { fontSize: 13.5, color: "var(--text-secondary)", margin: "0 0 18px 0", lineHeight: 1.4 },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  storeChip: (active) => ({
    textAlign: "left", padding: "13px 15px", borderRadius: 18, cursor: "pointer",
    border: active ? `1.5px solid rgba(10,132,255,0.55)` : "1px solid var(--hairline)",
    ...glass(active ? 0.7 : 0.45, 12),
    boxShadow: active ? "0 4px 14px rgba(10,132,255,0.18)" : "none",
    color: "var(--text-primary)",
  }),
  rowChip: (active) => ({
    display: "flex", alignItems: "center", justifyContent: "space-between", textAlign: "left", padding: "13px 15px", borderRadius: 18, cursor: "pointer",
    border: active ? `1.5px solid rgba(10,132,255,0.55)` : "1px solid var(--hairline)",
    ...glass(active ? 0.7 : 0.45, 12),
    boxShadow: active ? "0 4px 14px rgba(10,132,255,0.18)" : "none",
    color: "var(--text-primary)",
  }),
  chipHint: { fontSize: 12, color: "var(--text-tertiary)", marginTop: 4, lineHeight: 1.4, fontWeight: 400 },
  stack: { display: "flex", flexDirection: "column", gap: 8 },
  counterRow: { display: "flex", alignItems: "center", justifyContent: "center", gap: 24, marginTop: 8 },
  counterBtn: { width: 44, height: 44, borderRadius: "50%", border: "1px solid var(--hairline)", ...glass(0.6, 10), color: ACCENT, fontSize: 20, cursor: "pointer", lineHeight: 1, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" },
  counterVal: { fontSize: 36, fontWeight: 700, minWidth: 44, textAlign: "center" },
  counterCaption: { textAlign: "center", fontSize: 13, color: "var(--text-tertiary)", marginTop: 8 },
  // Компактная версия counterBtn/counterVal — для строчных степперов внутри
  // mealTimeRow (порции по приёмам пищи), а не отдельного центрированного
  // шага визарда. 32px — то же соображение по тач-зоне 24×24 (WCAG 2.5.8),
  // что и у counterBtn/pantryBtn, просто с меньшим визуальным весом рядом с
  // коротким лейблом приёма пищи.
  counterBtnSmall: { width: 32, height: 32, borderRadius: "50%", border: "1px solid var(--hairline)", ...glass(0.6, 8), color: ACCENT, fontSize: 16, cursor: "pointer", lineHeight: 1 },
  counterValSmall: { fontSize: 15, fontWeight: 700, minWidth: 18, textAlign: "center" },
  // Текстовая ссылка-переключатель ("Уточнить по приёмам пищи" / "Одинаково
  // для всех") — сознательно не chip/rowChip: это необязательное
  // дополнительное действие, не должно выглядеть как ещё один такой же по
  // весу выбор, что и сами приёмы пищи выше.
  linkBtn: { background: "none", border: "none", padding: "4px 0", color: ACCENT, fontSize: 13.5, fontWeight: 600, cursor: "pointer" },
  diagBox: { display: "flex", flexDirection: "column", border: "1px solid var(--hairline)", borderRadius: 14, overflow: "hidden", ...glass(0.45, 8) },
  diagRow: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", fontSize: 13, gap: 12 },
  diagValue: { color: "var(--text-tertiary)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5, textAlign: "right" },
  budgetVal: { fontSize: 36, fontWeight: 700, textAlign: "center", marginBottom: 16 },
  slider: { width: "100%" },
  sliderLabels: { display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-tertiary)", marginTop: 6 },
  navRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "auto", paddingTop: 22 },
  // Раньше — голый текст с иконкой, без фона и рамки: единственный элемент
  // интерфейса без стеклянного оформления, на фоне чипов/кнопок/бейджей
  // вокруг он выглядел "недоделанным". Теперь та же лёгкая стеклянная
  // пилюля, что у remainder кнопок — просто менее контрастная, чем
  // navBtnPrimary ("Далее"), чтобы порядок важности читался однозначно.
  // navBtn и navBtnPrimary раньше отличались не только цветом, но и
  // padding/fontSize/line-height — из-за этого "Назад" и "Далее" в одном и
  // том же ряду визуально были разного размера, хотя должны читаться как
  // пара равнозначных по геометрии кнопок с разным уровнем акцента. Теперь
  // геометрия (padding, fontSize, lineHeight, gap) у обеих идентична,
  // отличается только оформление (фон/рамка/тень) — так пара выглядит
  // единообразно. lineHeight: 1 — иконка (фиксированная высота SVG) и текст
  // (высота строки шрифта, обычно больше самого глифа) центровались по
  // alignItems:"center" каждый по СВОЕЙ высоте box'а, из-за чего текст
  // визуально "плавал" на пиксель-два относительно иконки; line-height:1
  // прижимает высоту текстового box'а к фактической высоте глифов.
  navBtn: {
    display: "flex", alignItems: "center", gap: 4, lineHeight: 1, ...glass(0.4, 8), border: "1px solid var(--hairline)",
    color: "var(--text-secondary)", fontSize: 13.5, fontWeight: 500, cursor: "pointer", padding: "11px 18px", borderRadius: 999,
  },
  navBtnPrimary: { display: "flex", alignItems: "center", gap: 4, lineHeight: 1, background: `linear-gradient(180deg, ${ACCENT}, #0066DB)`, border: "none", color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer", padding: "11px 18px", borderRadius: 999, marginLeft: "auto", boxShadow: "0 6px 16px rgba(10,132,255,0.35)" },
  // Только для "Назад" в шапке Аккаунта (см. AccountView) — та же геометрия,
  // что у navBtn (display/alignItems/gap/lineHeight), но плотнее по padding:
  // navBtn рассчитан на пару с navBtnPrimary в одном ряду, эта кнопка стоит
  // одна, без пары, и с тем же padding выглядела непропорционально широкой.
  // Живая жалоба в чате: "чеврон далеко от слова 'Назад'" — было gap:4,
  // визуально терялось на реальном экране; gap:6 — тот же зазор, что и у
  // остальных пар иконка+текст в этом файле (retryPricesBtn, storeChip и т.п.).
  acctBackBtn: {
    display: "flex", alignItems: "center", gap: 6, lineHeight: 1, ...glass(0.4, 8), border: "1px solid var(--hairline)",
    color: "var(--text-secondary)", fontSize: 13.5, fontWeight: 500, cursor: "pointer", padding: "8px 13px", borderRadius: 999,
  },
  resultHeader: { marginBottom: 14 },
  warningBox: { display: "flex", gap: 8, alignItems: "flex-start", background: "var(--warning-soft)", border: "1px solid var(--warning-border)", borderRadius: 16, padding: "12px 14px", fontSize: 12.5, color: "var(--warning-text)", marginBottom: 14, lineHeight: 1.4 },
  // --warning-text (#8a5a1e, тёмно-коричневый) не переопределяется в тёмной
  // теме (см. :root) — то есть остаётся одним и тем же в обеих темах, поэтому
  // белый текст поверх него безопасен и там, и там, отдельного dark-варианта
  // не нужно.
  retryPricesBtn: {
    display: "flex", alignItems: "center", gap: 6, marginTop: 8, background: "var(--warning-text)", color: "#fff",
    border: "none", borderRadius: 999, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer",
  },
  totalBox: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "18px 0", border: "1px solid var(--hairline)", borderRadius: 20, marginBottom: 20, ...glass(0.55, 12) },
  sectionTitle: { fontSize: 13, fontWeight: 600, color: "var(--text-tertiary)", margin: "0 0 8px 0" },
  dayBlock: { paddingBottom: 8, marginBottom: 4, borderBottom: "1px solid var(--hairline)" },
  dayTag: { fontSize: 11, fontWeight: 700, color: ACCENT, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.02em" },
  dayTagToday: { display: "inline-block", background: ACCENT, color: "#fff", padding: "2px 9px", borderRadius: 8 },
  recipeMeta: { display: "block", fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 },
  // Главное действие экрана плана закреплено внизу, пока не долистали до
  // его естественного места в конце списка (UX-аудит 29.09.2026: кнопка была
  // за ~5 экранами прокрутки).
  orderBtnSticky: { position: "sticky", bottom: "max(12px, env(safe-area-inset-bottom))", zIndex: 5 },
  recipeRow: { display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 14 },
  timeBadge: { display: "flex", alignItems: "center", gap: 3, color: "var(--text-tertiary)", fontSize: 11, flexShrink: 0 },
  // padding было 2 — вместе с иконкой 14px тап-зона выходила ~18×18,
  // заметно ниже минимума WCAG 2.5.8 AA (24×24) для часто используемого
  // действия ("Заменить блюдо" на каждой строке рецепта). 9 даёт ~32×32.
  swapBtn: (canSwap) => ({ display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", padding: 9, margin: -9, flexShrink: 0, color: ACCENT, cursor: canSwap ? "pointer" : "default", opacity: canSwap ? 0.8 : 0.25 }),
  deptLabelBtn: { display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "none", border: "none", padding: "4px 0", cursor: "pointer" },
  deptLabel: { fontSize: 12, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.02em" },
  listBox: { display: "flex", flexDirection: "column" },
  listRow: { display: "flex", justifyContent: "space-between", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--hairline-2)", fontSize: 13.5 },
  subFindBtn: { display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", padding: 2, color: "var(--text-tertiary)", cursor: "pointer" },
  subRevertBtn: { display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", padding: 2, color: "var(--danger)", cursor: "pointer" },
  // "Уже есть дома" (см. lib/pantry.js) — padding 6 (не 2, как у соседних
  // subFindBtn/subRevertBtn) — те уже отмечены как слишком мелкая тач-зона
  // при аудите доступности, не повторяем ту же ошибку в новом элементе:
  // 13 (иконка) + 6*2 = 25px, укладывается в минимум WCAG 2.5.8 (24×24).
  buyLaterBadge: { fontSize: 11, color: "var(--warning-text)", fontWeight: 600, whiteSpace: "nowrap" },
  pantryBtn: { display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", padding: 6, margin: -6, color: "var(--text-tertiary)", cursor: "pointer" },
  pantryBtnActive: { display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", padding: 6, margin: -6, color: "var(--accent)", cursor: "pointer" },
  subPanel: { display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px 10px", marginBottom: 4, borderRadius: 14, ...glass(0.5, 10), border: "1px solid var(--hairline)" },
  subPanelHint: { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--text-tertiary)" },
  subOptionBtn: { display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: "none", border: "1px solid var(--hairline)", borderRadius: 10, padding: "8px 10px", fontSize: 12.5, color: "var(--text-primary)", cursor: "pointer" },
  subOptionThumb: { width: 28, height: 28, borderRadius: 7, objectFit: "cover", flexShrink: 0 },
  subOptionThumbPlaceholder: { width: 28, height: 28, borderRadius: 7, flexShrink: 0, background: "var(--track-bg)" },
  subCancelBtn: { alignSelf: "flex-end", background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 12, cursor: "pointer", padding: "2px 4px" },
  orderBtn: { width: "100%", padding: "14px 0", background: `linear-gradient(180deg, ${ACCENT}, #0066DB)`, border: "none", borderRadius: 18, color: "#fff", fontSize: 14.5, fontWeight: 600, cursor: "pointer", marginTop: 8, boxShadow: "0 8px 20px rgba(10,132,255,0.35)" },
  orderError: { fontSize: 12, color: "var(--danger)", textAlign: "center", marginTop: 8 },
  orderNote: { fontSize: 12, color: "var(--text-tertiary)", textAlign: "center", marginTop: 8, lineHeight: 1.4 },
  orderPartsWrap: { display: "flex", flexDirection: "column", gap: 8, marginTop: 4 },
  orderPartBtn: {
    width: "100%", padding: "11px 0", background: "transparent", border: `1.5px solid ${ACCENT}`,
    borderRadius: 16, color: ACCENT, fontSize: 13.5, fontWeight: 600, cursor: "pointer",
  },
  shareBtn: { width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "13px 0", ...glass(0.6, 10), border: "1px solid var(--hairline)", borderRadius: 18, color: "var(--text-primary)", fontSize: 14, fontWeight: 600, cursor: "pointer", marginTop: 8 },

  recipeRowBtn: { flex: 1, display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", padding: "4px 2px", borderRadius: 10, textAlign: "left", cursor: "pointer", color: "var(--text-primary)", font: "inherit", minWidth: 0 },
  recipeEmoji: { fontSize: 20, flexShrink: 0, width: 34, textAlign: "center" },
  // Раньше длинные названия (особенно у ВкусВилл — "Тушёные куриные желудки"
  // и длиннее) в тесной строке (иконка + время + цена + кнопка замены на
  // одной линии) расползались на 3-4 строки — нечитаемо. line-clamp режет
  // ровно на 2 строки с многоточием, не трогая сам layout строки.
  recipeName: {
    fontWeight: 500, minWidth: 0,
    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
    overflow: "hidden", wordBreak: "break-word", lineHeight: 1.25,
  },
  recipeThumb: { width: 34, height: 34, borderRadius: 9, objectFit: "cover", flexShrink: 0 },

  modalOverlay: { position: "fixed", inset: 0, background: "var(--modal-backdrop)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 50 },
  modalCard: { width: "100%", maxWidth: 420, maxHeight: "85vh", overflowY: "auto", ...glass(0.9, 30), borderRadius: 28, border: "1px solid var(--hairline)", padding: 26, boxShadow: "var(--modal-shadow)", position: "relative" },
  modalClose: { position: "absolute", top: 16, right: 16, width: 32, height: 32, borderRadius: "50%", border: "1px solid var(--hairline)", background: "rgba(120,120,128,0.16)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--text-primary)" },
  modalHero: { width: "100%", height: 120, borderRadius: 20, background: "linear-gradient(135deg, rgba(10,132,255,0.14), rgba(100,210,255,0.14))", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 56, marginBottom: 16 },
  modalHeroPhoto: { width: "100%", height: 180, borderRadius: 20, objectFit: "cover", marginBottom: 16, display: "block" },
  modalMeta: { display: "flex", gap: 14, fontSize: 13, color: "var(--text-tertiary)", marginBottom: 18, flexWrap: "wrap" },
  videoSearchLink: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 18,
    padding: "12px 0", borderRadius: 16, border: "1px solid var(--hairline)", ...glass(0.45, 10),
    color: "var(--text-primary)", fontSize: 13.5, fontWeight: 600, textDecoration: "none",
  },
  stepsList: { margin: 0, padding: "0 0 0 18px", display: "flex", flexDirection: "column", gap: 8, fontSize: 13.5, lineHeight: 1.5, color: "var(--text-primary)" },
  stepItem: { paddingLeft: 4 },

  skeletonBar: (h, w) => ({ height: h, width: w || "100%", marginBottom: 10 }),
  assemblingCaption: { display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: "var(--text-secondary)", marginBottom: 20 },
};
