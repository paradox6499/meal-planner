// Глобальный CSS приложения: цветовые токены светлой/тёмной темы, анимации,
// служебные классы (.mp-page, .chip, .spin и т.п.). Рендерится одним <style> в
// MealPlanner (App.jsx) — строка перенесена оттуда без изменений.
export const GLOBAL_CSS = `
        :root {
          --page-bg: radial-gradient(circle at 12% 15%, #dcebff 0%, transparent 42%), radial-gradient(circle at 88% 12%, #ffe1f0 0%, transparent 40%), radial-gradient(circle at 50% 95%, #dcfce4 0%, transparent 45%), #eef1f5;
          --glass-rgb: 255,255,255;
          --strip-bg: rgba(244,246,250,0.9);
          --text-primary: #1c1c1e;
          --text-secondary: #6e6e73;
          /* Было #8e8e93 — 2.88:1 на фоне страницы, ниже минимума WCAG AA
             (4.5:1 для обычного текста). Этим цветом подписаны хинты/подписи/
             футер по всему приложению, не мелочь. #6c6c70 даёт 4.61:1 с
             запасом на самом светлом реальном фоне (голая --page-bg). */
          --text-tertiary: #5f5f64;
          --accent: #0A84FF;
          --accent-2: #64D2FF;
          --danger: #FF3B30;
          /* Красный ТЕКСТ: #FF3B30 на светлом/розовом даёт 2,8:1 (ниже WCAG AA). Для заливок и иконок остаётся --danger. */
          --danger-text: #C4161C;
          /* Синий ТЕКСТ (ссылки, даты): #0A84FF на светлой карточке даёт 3,5:1. Для заливок и иконок остаётся ACCENT. */
          --accent-text: #0066CC;
          --danger-soft: rgba(255,59,48,0.14);
          --warning-soft: rgba(255,159,10,0.14);
          --warning-border: rgba(255,159,10,0.35);
          --warning-text: #8a5a1e;
          --hairline: rgba(0,0,0,0.06);
          --hairline-2: rgba(0,0,0,0.05);
          --card-shadow: 0 24px 60px rgba(20,20,30,0.12), inset 0 1px 0 rgba(255,255,255,0.6);
          --modal-backdrop: rgba(20,20,30,0.4);
          --modal-shadow: 0 30px 80px rgba(0,0,0,0.35);
          --skeleton-base: rgba(120,120,128,0.12);
          --skeleton-shine: rgba(120,120,128,0.24);
          --track-bg: rgba(60,60,67,0.15);
        }
        /* Раньше тема была только автоматической (prefers-color-scheme), без
           ручного переключателя. Теперь в Аккаунте можно явно выбрать
           светлую/тёмную — :not([data-theme="light"]) в media-блоке не даёт
           системной тёмной теме перебить явный выбор "светлая", а отдельный
           :root[data-theme="dark"] ниже включает тёмную тему явно даже если
           система светлая. */
        @media (prefers-color-scheme: dark) {
          :root:not([data-theme="light"]) {
            --page-bg: radial-gradient(circle at 12% 15%, rgba(10,70,130,0.4) 0%, transparent 42%), radial-gradient(circle at 88% 12%, rgba(140,20,80,0.32) 0%, transparent 40%), radial-gradient(circle at 50% 95%, rgba(20,100,55,0.32) 0%, transparent 45%), #0b0b0d;
            --glass-rgb: 42,42,46;
            --strip-bg: rgba(30,30,36,0.92);
            --text-primary: #f2f2f7;
            --text-secondary: #b6b6bb;
            --text-tertiary: #8e8e93;
          --danger-text: #FF6961;
          --accent-text: #4DA3FF;
            --danger-text: #FF6961;
            --accent-text: #4DA3FF;
            /* Раньше --warning-text вообще не переопределялся для тёмной
               темы — оставался #8a5a1e (тёмно-коричневый, задуман для
               светлого --warning-soft фона). На тёмном фоне это 2.69-3.34:1 —
               заметно ниже AA, а этим цветом написано предупреждение "не
               удалось получить цены" и хинт "сначала выберите рацион" —
               сообщения, которые реально нужно прочитать. #ffc466 даёт
               ~10-12:1 на тёмных фонах, остаётся в той же "тёплой" палитре. */
            --warning-text: #ffc466;
            --hairline: rgba(255,255,255,0.1);
            --hairline-2: rgba(255,255,255,0.08);
            --card-shadow: 0 24px 60px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06);
            --modal-backdrop: rgba(0,0,0,0.6);
            --modal-shadow: 0 30px 80px rgba(0,0,0,0.6);
            --skeleton-base: rgba(255,255,255,0.08);
            --skeleton-shine: rgba(255,255,255,0.16);
            --track-bg: rgba(255,255,255,0.14);
          }
        }
        :root[data-theme="dark"] {
          --page-bg: radial-gradient(circle at 12% 15%, rgba(10,70,130,0.4) 0%, transparent 42%), radial-gradient(circle at 88% 12%, rgba(140,20,80,0.32) 0%, transparent 40%), radial-gradient(circle at 50% 95%, rgba(20,100,55,0.32) 0%, transparent 45%), #0b0b0d;
          --glass-rgb: 42,42,46;
            --strip-bg: rgba(30,30,36,0.92);
          --text-primary: #f2f2f7;
          --text-secondary: #b6b6bb;
          --text-tertiary: #8e8e93;
          --warning-text: #ffc466;
          --hairline: rgba(255,255,255,0.1);
          --hairline-2: rgba(255,255,255,0.08);
          --card-shadow: 0 24px 60px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06);
          --modal-backdrop: rgba(0,0,0,0.6);
          --modal-shadow: 0 30px 80px rgba(0,0,0,0.6);
          --skeleton-base: rgba(255,255,255,0.08);
          --skeleton-shine: rgba(255,255,255,0.16);
          --track-bg: rgba(255,255,255,0.14);
        }
        * { box-sizing: border-box; }
        .chip { transition: background-color .15s ease, border-color .15s ease, transform .18s cubic-bezier(0.34, 1.56, 0.64, 1); -webkit-tap-highlight-color: transparent; }
        .chip:hover { filter: brightness(1.03); }
        .chip:active { transform: scale(0.97); }
        button { font-family: inherit; }
        .recipe-row-btn:hover .recipe-name-text { text-decoration: underline; text-decoration-color: rgba(10,132,255,0.4); }
        .fade-in-up { animation: fadeInUp .32s cubic-bezier(0.22, 1, 0.36, 1) both; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .greeting-fade { animation: greetingFade 3s ease forwards; }
        @keyframes greetingFade { 0%, 80% { opacity: 1; } 100% { opacity: 0; } }
        .modal-overlay-in { animation: overlayIn .2s ease both; }
        @keyframes overlayIn { from { opacity: 0; } to { opacity: 1; } }
        .modal-card-in { animation: modalIn .28s cubic-bezier(0.22, 1, 0.36, 1) both; }
        @keyframes modalIn { from { opacity: 0; transform: scale(0.94) translateY(12px); } to { opacity: 1; transform: scale(1) translateY(0); } }
        .skeleton-bar { border-radius: 12px; background: linear-gradient(90deg, var(--skeleton-base) 25%, var(--skeleton-shine) 37%, var(--skeleton-base) 63%); background-size: 400% 100%; animation: shimmer 1.4s ease infinite; }
        @keyframes shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        /* Раньше все анимации (переходы шагов, модалки, шиммер скелетона,
           даже crutch-вращение спиннера) играли безусловно — ни одна не
           уважала системную настройку "уменьшить движение" (укачивание,
           вестибулярные нарушения и т.п.). Спиннер оставляем — он несёт
           смысл (идёт загрузка), просто без вращения был бы непонятен;
           у него уже линейный минимальный keyframe. Остальное — либо
           убираем движение полностью (только opacity), либо сокращаем
           длительность почти до нуля. */
        /* Размытие фона нужно только самой карточке. На экране Аккаунта у каждой строки, чипа и
           кнопки было своё backdrop-filter — 63 штуки на одном экране; WebKit пересчитывает каждое
           при прокрутке, отсюда «тормозит». Внутри карточки оставляем только полупрозрачную заливку. */
        .mp-card *:not(.day-strip) { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
        .basket-body { position: absolute; left: 50%; bottom: 0; transform: translateX(-50%); font-size: 52px; line-height: 1; animation: basket-bob 1.6s ease-in-out infinite; }
        .basket-drop { position: absolute; top: -8px; font-size: 24px; line-height: 1; opacity: 0; animation: basket-drop 2.25s cubic-bezier(.4,0,.6,1) infinite; }
        @keyframes basket-drop {
          0% { opacity: 0; left: var(--from); top: -8px; transform: translateX(-50%) scale(1); }
          12% { opacity: 1; }
          72% { opacity: 1; }
          100% { opacity: 0; left: 50%; top: 56px; transform: translateX(-50%) scale(.5); }
        }
        @keyframes basket-bob { 0%, 100% { transform: translateX(-50%) translateY(0); } 50% { transform: translateX(-50%) translateY(-3px); } }
        @media (prefers-reduced-motion: reduce) {
          .basket-drop { animation: none !important; opacity: 1; position: static; display: inline-block; margin: 0 4px; }
          .basket-body { animation: none !important; }
          .fade-in-up, .modal-card-in { animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
          .greeting-fade { animation: none !important; opacity: 1; }
          .skeleton-bar { animation-duration: 2.8s !important; }
          .chip { transition: none !important; }
        }
        /* На узких экранах (телефон, в т.ч. внутри Telegram Mini App) — не
           плавающая карточка на фоне с большими полями, а карточка во весь
           экран, как у нативных приложений. 100dvh, а не 100vh — динамическая
           высота viewport'а, корректно учитывает шторки/безопасные зоны
           мобильных браузеров и WebView Telegram (обычный 100vh там часто
           врёт, оставляя пустое место снизу — это была жалоба). */
        @media (max-width: 600px) {
          .mp-page { padding: 0 !important; align-items: stretch !important; }
          .mp-card {
            max-width: 100% !important; min-height: 100dvh !important; border-radius: 0 !important;
            border-left: none !important; border-right: none !important;
            /* Раньше карточка была растянута на 100dvh, но её содержимое —
               обычный блочный поток, поэтому короткие шаги (например выбор
               магазина) оставляли пустую область снизу до конца экрана —
               визуально выглядело как "не заполнено", хотя карточка технически
               была на всю высоту. Теперь сама карточка — flex-колонка, а
               тело шага (.mp-step-body) занимает всё оставшееся место и
               центрирует контент по вертикали, как в нативных онбордингах. */
            display: flex !important; flex-direction: column !important;
          }
          /* Раньше здесь стоял justify-content:center — контент шага и кнопка
             центрировались как единая группа, но из-за этого между строкой
             "Шаг X из Y" и самим шагом появлялся заметный пустой отступ
             сверху (жалоба). Контенту лучше идти сразу за прогресс-баром —
             flex-start (по умолчанию), а не искать симметрию. Оставшееся
             свободное место (flex:1 на body) само уходит вниз, ПОСЛЕ кнопки —
             это просто безопасный отступ у нижнего края экрана, а не дыра
             посреди интерфейса. */
          .mp-step-body { flex: 1; }
          /* navRow держит marginTop:auto для "плавающей" карточки на десктопе
             (там это нужно, чтобы кнопка не отрывалась от контента при
             разной длине шагов) — но на mobile это же auto съедало ВСЁ
             свободное место сам по себе, из-за чего кнопка уезжала в самый
             низ, а контент оставался прижат к верху с разрывом посередине.
             Обычный фиксированный отступ вместо auto — кнопка идёт сразу за
             контентом шага. */
          .mp-nav-row { margin-top: 22px !important; }
          .mp-result-body, .mp-skeleton-body, .mp-account-body { flex: 1; }
        }
        input[type="range"] { -webkit-appearance: none; height: 4px; border-radius: 2px; background: var(--track-bg); }
        input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.04); cursor: pointer; }
        /* Нативная иконка часов у <input type="time"> красится браузером сама
           (обычно серым/чёрным) — CSS не даёт задать ей произвольный цвет
           напрямую. Прячем её (opacity почти 0, а не 0 — на части WebKit
           полностью прозрачный элемент перестаёт быть кликабельным), а
           поверх рисуем свою Clock-иконку в акцентном цвете (см. mealTimeRow
           в JSX) — клик всё равно попадает на невидимый нативный контрол под
           ней, просто визуально показываем свою. */
        input[type="time"]::-webkit-calendar-picker-indicator { opacity: 0.015; }
`;
