// Экран «Аккаунт».

import { useState } from "react";
import { MonitorSmartphone, Sun, Moon, ChevronLeft, MessageCircle, Home, Check, Clock } from "lucide-react";
import { ALLERGENS } from "../../data/recipes.js";
import { getBackendUrl, sendSupportPrompt } from "../../lib/backend.js";
import { trackEvent } from "../../lib/analytics.js";
import { hapticSelect, hapticImpact } from "../../lib/haptics.js";
import { styles, ACCENT } from "../../styles.js";
import { SUPPORT_URL, MEALS, DEFAULT_MEAL_TIMES, DIETS, CUISINES, DEVICES, COOK_TIME_TIERS } from "../../constants.js";
import { AccountSubscriptionCard } from "./SubscriptionCard.jsx";
import { DislikesPicker } from "../DislikesPicker.jsx";
import { FamilySection } from "./FamilySection.jsx";
import { ReferralSection } from "./ReferralSection.jsx";
import { ProgressSection } from "./ProgressSection.jsx";
import { PlanHistorySection } from "./PlanHistorySection.jsx";
import { LegalAndDataSection } from "./LegalAndDataSection.jsx";

export const THEME_OPTIONS = [
  { id: "system", label: "Системная", icon: MonitorSmartphone },
  { id: "light", label: "Светлая", icon: Sun },
  { id: "dark", label: "Тёмная", icon: Moon },
];

// Вкладка "Аккаунт" — открывается поверх визарда/результата (не отдельный
// роут, это одностраничное приложение без роутера). Тут живёт всё, что
// пользователь настраивает один раз и не хочет проходить заново на каждую
// сборку плана: профиль (семья/приёмы пищи/рацион/аллергии/кухня/техника),
// имя для приветствия и тема. Плюс место под подписку — см. комментарий
// у AccountSubscriptionCard ниже про то, почему кнопка пока не платит.
export function AccountView({
  displayName, setDisplayName, theme, setTheme,
  family, setFamily, familyByMeal, setFamilyByMeal, meals, setMeals, diet, setDiet,
  allergies, setAllergies, dislikes, setDislikes, cuisines, setCuisines, devices, setDevices,
  maxCookTime, setMaxCookTime,
  mealTimes, setMealTimes,
  toggleSimple, toggleCuisine, hasProfile, onSave, onClear, onClose, onOpenPro,
  homeScreenStatus, onAddToHomeScreen,
  planStatus, planHistory, referralStatus,
  familyStatus, familyActionState, onCreateFamily, onLeaveFamily,
}) {
  const [saved, setSaved] = useState(false);
  const handleSave = () => {
    onSave();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // Диагностика подключения — жалоба в чате: несколько кругов "проверьте
  // логи" ни к чему не привели, потому что оказалось, что вопрос был не в
  // сервере (он всё это время отвечал нормально), а в том, доходит ли
  // запрос от приложения до него вообще — trackEvent и createProPayment оба
  // молча ничего не отправляют без initData/адреса сервера (см. lib/backend.js,
  // lib/analytics.js), и раньше узнать это можно было только через DevTools
  // или curl с моей стороны. Теперь то же самое видно прямо в приложении,
  // без консоли — одним взглядом или скриншотом в поддержку.
  const [showDiag, setShowDiag] = useState(false);
  const diagTg = window.Telegram?.WebApp;
  // Настоящий адрес, не просто "настроен/не настроен" — именно так нашёлся
  // прод-баг (жалоба "http 404: not found"): VITE_BACKEND_URL был задан с
  // завершающим слешем, из-за которого КАЖДЫЙ вызов бэкенда уходил в
  // двойной слеш и молча 404-ился на нашем же роутере (см. getBackendUrl в
  // backend.js). Показываем сырое значение — такую опечатку видно сразу, не
  // дожидаясь ещё одного круга "проверьте логи".
  const diagBackendUrl = getBackendUrl() || null;
  const diagInitData = diagTg?.initData || "";
  // Длина, не само значение — initData несёт подписанные данные пользователя,
  // показывать их в интерфейсе незачем даже себе самому.
  const diagRows = [
    ["Адрес сервера", diagBackendUrl || "не настроен"],
    ["Telegram WebApp", diagTg ? "обнаружен" : "не обнаружен"],
    ["initData", diagInitData ? `есть (${diagInitData.length} симв.)` : "отсутствует"],
    ["Платформа", diagTg?.platform || "—"],
    ["Версия Mini Apps API", diagTg?.version || "—"],
    ["Telegram ID", diagTg?.initDataUnsafe?.user?.id || "—"],
  ];

  // Порции по приёмам пищи — свёрнуто по умолчанию (не усложняет экран тем,
  // у кого вся семья ест одинаково), но сразу раскрыто, если такие
  // переопределения уже есть — чтобы не прятать уже сделанную настройку.
  const [showMealPortions, setShowMealPortions] = useState(() => Object.keys(familyByMeal || {}).length > 0);
  const familyForMeal = (mealId) => familyByMeal?.[mealId] ?? family;
  const setMealFamily = (mealId, updater) => {
    hapticSelect();
    setFamilyByMeal((prev) => {
      const cur = prev?.[mealId] ?? family;
      const next = typeof updater === "function" ? updater(cur) : updater;
      return { ...prev, [mealId]: Math.max(1, Math.min(8, next)) };
    });
  };
  const resetMealPortions = () => {
    hapticImpact("light");
    setFamilyByMeal({});
  };

  return (
    <div className="fade-in-up mp-account-body" style={styles.stepBody}>
      <div style={styles.accountHeaderRow}>
        {/* Раньше — тот же styles.navBtn, что у пары "Назад"/"Далее" в
            визарде: тот padding (11px 18px) рассчитан на пару пилюль РЯДОМ
            друг с другом, где обе тянут взгляд к центру ряда. Здесь кнопка
            одна, слева, без пары — с тем же padding пилюля выглядела
            непропорционально широкой для короткого "‹ Назад" внутри, будто
            текст и иконка потерялись в пустом пространстве (жалоба в чате:
            "надпись далеко от знака, будто не отцентровано" — сама пара
            иконка+текст была центрирована корректно, просто пилюля вокруг
            была ощутимо больше своего содержимого). Своя, более плотная
            пилюля — той же геометрии (lineHeight:1, gap), что не потеряла
            фикс вертикального выравнивания. */}
        <button onClick={onClose} style={styles.acctBackBtn}>
          <ChevronLeft size={16} /><span>Назад</span>
        </button>
      </div>
      <h2 style={{ ...styles.stepTitle, marginTop: 4 }}>Аккаунт</h2>

      {/* Жалоба в чате: "история планов находится внизу настроек аккаунта,
          надо вынести наверх, чтобы пользователю не мотать вниз" — раньше
          была самым последним блоком экрана, ПОСЛЕ всего длинного "Профиль
          для плана" (семья/рацион/аллергии/кухни и т.д.) и карточки
          подписки. Самое частое, зачем вообще открывают Аккаунт после
          первой настройки — посмотреть, что уже собирали, поэтому теперь
          это первое, что видно, без прокрутки. */}
      <PlanHistorySection planHistory={planHistory} />
      {/* Жалоба в чате: "История планов близко к самому плану находится" —
          дальше сразу шли настройки без какой-либо визуальной паузы. Тот же
          разделитель, что уже стоит между "Профиль для плана" и карточками
          ниже (styles.acctDivider) — история чётко отделена как отдельный,
          самостоятельный блок, а не хвост настроек профиля. planHistory===null
          (нечем спросить/бэкенд недоступен) — тот же случай, когда сам
          PlanHistorySection ничего не рендерит (см. её же условие ниже),
          разделитель тогда тоже лишний — висел бы прямо под заголовком. */}
      {planHistory !== null && <div style={styles.acctDivider} />}

      <div style={styles.acctSection}>
        <div style={styles.acctLabel}>Как к вам обращаться</div>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          placeholder="Имя для приветствия"
          enterKeyHint="done"
          style={styles.textInput}
        />
      </div>

      <div style={styles.acctSection}>
        <div style={styles.acctLabel}>Тема</div>
        <div style={{ display: "flex", gap: 8 }}>
          {THEME_OPTIONS.map(({ id, label, icon: Icon }) => (
            <button key={id} className="chip" onClick={() => setTheme(id)} style={styles.themeChip(theme === id)}>
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {SUPPORT_URL && (
        <div style={styles.acctSection}>
          <button
            className="chip"
            onClick={async () => {
              hapticImpact("light");
              trackEvent("support_clicked");
              // Раньше — openTelegramLink(SUPPORT_URL). Жалоба в чате: "кнопка
              // никуда не переводит", воспроизвели на двух разных аккаунтах и
              // устройствах — не случайность одного клиента. SUPPORT_URL у нас
              // указывает на ТОГО ЖЕ БОТА, что и держит текущий Mini App
              // (@s_edim_bot — по замыслу поддержка ведёт в чат с самим ботом,
              // не на личный аккаунт разработчика, см. webhook.js). Открыть
              // ссылку "на самого себя" через openTelegramLink — известная
              // проблема Telegram Mini Apps: клиент и так уже "внутри" чата с
              // этим ботом, и на части платформ команда открыть ЭТУ ЖЕ ссылку
              // просто ничего не делает. Мини-апп всегда запущен ПОВЕРХ чата с
              // открывшим его ботом — надёжный способ вернуть пользователя в
              // этот чат, чтобы он написал сообщение, это закрыть сам Mini App
              // (WebApp.close() — официальный метод, работает на всех
              // клиентах, а не только там, где openTelegramLink не игнорирует
              // ссылку на себя). Вне Telegram (локальный просмотр, close()
              // недоступен) — по-прежнему открываем как обычную ссылку.
              //
              // Просьба в чате: "чтобы высвечивалось, что напишите сейчас это
              // обращение и мы отправим его в поддержку" — пустой чат сам по
              // себе не объясняет, что теперь нужно просто написать
              // сообщение. Ждём отправку подсказки (короткий таймаут внутри
              // sendSupportPrompt — не best-effort, значит "не блокируем
              // кнопку надолго"), чтобы пользователь увидел её уже открытым
              // чатом, а не спустя секунду после того, как Mini App закрылся.
              await sendSupportPrompt();
              const tg = window.Telegram?.WebApp;
              if (tg?.close) tg.close();
              else if (tg?.openTelegramLink) tg.openTelegramLink(SUPPORT_URL);
              else window.open(SUPPORT_URL, "_blank");
            }}
            style={styles.rowChip(false)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <MessageCircle size={16} color={ACCENT} />
              <div>
                <div style={{ fontWeight: 600 }}>Написать в поддержку</div>
                <div style={styles.chipHint}>Можно приложить скриншот ошибки</div>
              </div>
            </div>
          </button>
        </div>
      )}

      {homeScreenStatus !== "unsupported" && (
        <div style={styles.acctSection}>
          <div style={styles.acctLabel}>Быстрый доступ</div>
          {homeScreenStatus === "added" ? (
            <div style={styles.homeScreenAddedRow}>
              <Home size={16} color={ACCENT} />
              <span>Уже на экране телефона</span>
            </div>
          ) : (
            <button onClick={onAddToHomeScreen} className="chip" style={styles.rowChip(false)}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Home size={16} color={ACCENT} />
                <div>
                  <div style={{ fontWeight: 600 }}>Добавить на экран</div>
                  <div style={styles.chipHint}>Открывать одним тапом, без захода в Telegram</div>
                </div>
              </div>
            </button>
          )}
        </div>
      )}

      <div style={styles.acctSection}>
        {!showDiag ? (
          <button className="chip" onClick={() => { hapticSelect(); setShowDiag(true); }} style={styles.linkBtn}>
            Диагностика подключения
          </button>
        ) : (
          <>
            <div style={styles.acctLabel}>Диагностика подключения</div>
            <p style={styles.acctSectionHint}>Если не работает оплата, напоминания или что-то ещё, что зависит от сервера — сделайте скриншот этого блока и пришлите в поддержку.</p>
            <div style={styles.diagBox}>
              {diagRows.map(([label, value], i) => (
                <div key={label} style={{ ...styles.diagRow, borderBottom: i === diagRows.length - 1 ? "none" : "1px solid var(--hairline)" }}>
                  <span>{label}</span><span style={styles.diagValue}>{value}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div style={styles.acctDivider} />

      <div style={styles.acctSection}>
        <div style={styles.acctSectionTitle}>Профиль для плана</div>
        <p style={styles.acctSectionHint}>
          Эти настройки редко меняются, поэтому сохраняются один раз — при следующей сборке плана визард спросит только магазин и бюджет.
        </p>

        <div style={styles.acctLabel}>Семья</div>
        <div style={styles.counterRow}>
          <button style={styles.counterBtn} onClick={() => setFamily((f) => Math.max(1, f - 1))}>−</button>
          <div style={styles.counterVal}>{family}</div>
          <button style={styles.counterBtn} onClick={() => setFamily((f) => Math.min(8, f + 1))}>+</button>
        </div>

        <div style={{ ...styles.acctLabel, marginTop: 16 }}>Приёмы пищи</div>
        <div style={styles.stack}>
          {MEALS.map((m) => (
            <button key={m.id} className="chip" onClick={() => toggleSimple(meals, setMeals, m.id)} style={styles.rowChip(meals.includes(m.id))}>
              <div style={{ fontWeight: 600 }}>{m.label}</div>
              {meals.includes(m.id) && <Check size={16} color={ACCENT} />}
            </button>
          ))}
        </div>

        {meals.length > 0 && (
          <div style={{ marginTop: 16 }}>
            {!showMealPortions ? (
              <button className="chip" onClick={() => { hapticSelect(); setShowMealPortions(true); }} style={styles.linkBtn}>
                Уточнить по приёмам пищи
              </button>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={styles.acctLabel}>Сколько человек на каждый приём пищи</div>
                  {Object.keys(familyByMeal || {}).length > 0 && (
                    <button className="chip" onClick={resetMealPortions} style={{ ...styles.linkBtn, padding: 0 }}>
                      Одинаково для всех
                    </button>
                  )}
                </div>
                <p style={styles.acctSectionHint}>
                  Например, если кто-то в семье ест дома не на все приёмы пищи — сколько человек реально закладывать в каждый.
                </p>
                <div style={styles.stack}>
                  {MEALS.filter((m) => meals.includes(m.id)).map((m) => (
                    <div key={m.id} style={styles.mealTimeRow}>
                      <span>{m.label}</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <button style={styles.counterBtnSmall} onClick={() => setMealFamily(m.id, (f) => f - 1)}>−</button>
                        <div style={styles.counterValSmall}>{familyForMeal(m.id)}</div>
                        <button style={styles.counterBtnSmall} onClick={() => setMealFamily(m.id, (f) => f + 1)}>+</button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {meals.length > 0 && (
          <>
            <div style={{ ...styles.acctLabel, marginTop: 16 }}>Во сколько обычно едите</div>
            <p style={styles.acctSectionHint}>Нужно только для напоминаний от бота — без этого мы не знаем, за сколько до еды написать.</p>
            <div style={styles.stack}>
              {MEALS.filter((m) => meals.includes(m.id)).map((m) => (
                <div key={m.id} style={styles.mealTimeRow}>
                  <span>{m.label}</span>
                  <div style={styles.timeInputWrap}>
                    <input
                      type="time"
                      value={mealTimes[m.id] || DEFAULT_MEAL_TIMES[m.id]}
                      onChange={(e) => setMealTimes((prev) => ({ ...prev, [m.id]: e.target.value }))}
                      style={styles.timeInput}
                    />
                    <Clock size={14} color={ACCENT} style={styles.timeInputIcon} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div style={{ ...styles.acctLabel, marginTop: 16 }}>Рацион</div>
        <div style={styles.stack}>
          {DIETS.map((d) => (
            <button key={d.id} className="chip" onClick={() => { hapticSelect(); setDiet(d.id); }} style={styles.rowChip(diet === d.id)}>
              <div style={{ fontWeight: 600 }}>{d.label}</div>
              {diet === d.id && <Check size={16} color={ACCENT} />}
            </button>
          ))}
        </div>

        <div style={{ ...styles.acctLabel, marginTop: 16 }}>Аллергии</div>
        <div style={styles.grid2}>
          <button className="chip" onClick={() => { hapticSelect(); setAllergies([]); }} style={styles.storeChip(allergies.length === 0)}>
            <div style={{ fontWeight: 600 }}>Нет</div>
          </button>
          {ALLERGENS.map((a) => (
            <button key={a.id} className="chip" onClick={() => toggleSimple(allergies, setAllergies, a.id)} style={styles.storeChip(allergies.includes(a.id))}>
              <div style={{ fontWeight: 600 }}>{a.label}</div>
            </button>
          ))}
        </div>

        <div style={{ ...styles.acctLabel, marginTop: 16 }}>Не люблю</div>
        <p style={styles.acctSectionHint}>Постараемся не брать такие блюда. Если подходящих совсем мало, часть всё же может попасть в план.</p>
        <DislikesPicker dislikes={dislikes} setDislikes={setDislikes} />

        <div style={{ ...styles.acctLabel, marginTop: 16 }}>Кухня</div>
        <div style={styles.grid2}>
          {CUISINES.map((c) => (
            <button key={c.id} className="chip" onClick={() => toggleCuisine(cuisines, setCuisines, c.id)} style={styles.storeChip(cuisines.includes(c.id) || (c.id === "any" && cuisines.length === 0))}>
              <div style={{ fontWeight: 600 }}>{c.label}</div>
            </button>
          ))}
        </div>

        <div style={{ ...styles.acctLabel, marginTop: 16 }}>Техника</div>
        <div style={styles.grid2}>
          <button
            className="chip"
            onClick={() => { hapticSelect(); setDevices(DEVICES.map((d) => d.id)); }}
            style={styles.storeChip(devices.length === DEVICES.length)}
          >
            <div style={{ fontWeight: 600 }}>Готовлю на всём</div>
          </button>
          {DEVICES.map((d) => (
            <button key={d.id} className="chip" onClick={() => toggleSimple(devices, setDevices, d.id)} style={styles.storeChip(devices.includes(d.id))}>
              <div style={{ fontWeight: 600 }}>{d.label}</div>
            </button>
          ))}
        </div>

        <div style={{ ...styles.acctLabel, marginTop: 16 }}>Время готовки</div>
        <div style={styles.stack}>
          {COOK_TIME_TIERS.map((t) => (
            <button key={t.id} className="chip" onClick={() => { hapticSelect(); setMaxCookTime(t.maxMinutes); }} style={styles.rowChip(maxCookTime === t.maxMinutes)}>
              <div>
                <div style={{ fontWeight: 600 }}>{t.label}</div>
                <div style={styles.chipHint}>{t.hint}</div>
              </div>
              {maxCookTime === t.maxMinutes && <Check size={16} color={ACCENT} />}
            </button>
          ))}
        </div>

        <button
          onClick={handleSave}
          disabled={!diet || meals.length === 0}
          style={{ ...styles.navBtnPrimary, width: "100%", justifyContent: "center", marginTop: 18, opacity: diet && meals.length > 0 ? 1 : 0.4 }}
        >
          {saved ? <><Check size={16} /> Сохранено</> : "Сохранить как профиль"}
        </button>
        {!diet && (
          <p style={styles.acctWarnHint}>Сначала выберите рацион выше — без него план собрать не получится.</p>
        )}
        {/* Раньше тут не было никакой защиты: можно было снять все галочки в
            "Приёмы пищи" выше и сохранить профиль с meals: [] — у вернувшегося
            пользователя шаг "Приёмы пищи" в визарде пропускается (см.
            QUICK_STEP_KEYS), поэтому это тихо давало каждую неделю "успешный"
            план без единого блюда (buildInitialPlan просто ничего не делает
            на пустом selectedMeals, warnings при этом тоже пустые — баннер
            предупреждения не показывался вообще). Найдено при аудите
            комбинаций, не из жалобы в чате. */}
        {diet && meals.length === 0 && (
          <p style={styles.acctWarnHint}>Выберите хотя бы один приём пищи выше — иначе план будет пустым.</p>
        )}
        {hasProfile && (
          <button onClick={onClear} style={styles.acctClearBtn}>
            Сбросить сохранённый профиль
          </button>
        )}
      </div>

      <div style={styles.acctDivider} />
      <ProgressSection planHistory={planHistory} />
      <AccountSubscriptionCard onOpenPro={onOpenPro} planStatus={planStatus} />
      <FamilySection
        familyStatus={familyStatus}
        isPro={!!planStatus?.isPro}
        actionState={familyActionState}
        onCreate={onCreateFamily}
        onLeave={onLeaveFamily}
        onOpenPro={onOpenPro}
      />
      <ReferralSection referralStatus={referralStatus} />
      <LegalAndDataSection />
    </div>
  );
}
