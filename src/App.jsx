import { useState, useEffect, useMemo } from "react";
import { RotateCcw, Settings } from "lucide-react";
import { saveProfile, clearProfile } from "./lib/profile.js";
import { loadActivePlanSlots, clearAllActivePlans } from "./lib/activePlan.js";
import { updateMealTimes, deletePlanFromHistory } from "./lib/backend.js";
import { trackEvent } from "./lib/analytics.js";
import { loadAcquisitionAnswered, saveAcquisitionAnswered, startParamKind } from "./lib/acquisition.js";
import logoUrl from "./assets/logo.svg";
import { hapticImpact, hapticNotify } from "./lib/haptics.js";
import { promptAddToHomeScreen } from "./lib/homeScreen.js";
import { styles } from "./styles.js";
import { GLOBAL_CSS } from "./globalCss.js";
import { STEP_META, QUICK_STEP_KEYS, STORES } from "./constants.js";
import { DismissibleNote, SkeletonView } from "./components/common.jsx";
import { RecipeModal } from "./components/RecipeModal.jsx";
import { AcquisitionCard } from "./components/AcquisitionCard.jsx";
import { ProModal, ExtraPlanModal } from "./components/ProModals.jsx";
import { LastPlanGateView } from "./components/LastPlanGateView.jsx";
import { LimitBlockedView } from "./components/LimitBlockedView.jsx";
import { WizardView } from "./components/WizardView.jsx";
import { PlanSlotsBar, ResultView } from "./components/ResultView.jsx";
import { AccountView } from "./components/account/AccountView.jsx";
import { usePlanStatus } from "./hooks/usePlanStatus.js";
import { useFamily } from "./hooks/useFamily.js";
import { useHomeScreen } from "./hooks/useHomeScreen.js";
import { useReferral, useReferralGift } from "./hooks/useReferral.js";
import { formatResetDate } from "./lib/format.js";
import { useTheme } from "./hooks/useTheme.js";
import { useWizardProfile } from "./hooks/useWizardProfile.js";
import { usePlanSession } from "./hooks/usePlanSession.js";

// Telegram сам присылает имя пользователя при открытии Mini App — это
// бесплатно (initDataUnsafe), никакого своего логина/аккаунта заводить не
// нужно. Вне Telegram (например, в этом браузерном превью) window.Telegram
// просто не существует — приветствие тогда не показываем вообще, а не
// подставляем заглушку "Гость".
function getTelegramFirstName() {
  return window.Telegram?.WebApp?.initDataUnsafe?.user?.first_name || null;
}

// ---------- Component ----------

export default function MealPlanner() {
  const [tgFirstName] = useState(getTelegramFirstName);

  // ready()/expand() — просим Telegram сразу развернуть Mini App на всю
  // доступную высоту, а не в свёрнутом состоянии по умолчанию. Без этого
  // сам Telegram может показывать приложение в неполный экран независимо
  // от нашего CSS — это его собственное поведение, не наш layout.
  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    tg.ready?.();
    tg.expand?.();
  }, []);

  // Ответы визарда, сохраняемые как профиль, — см. useWizardProfile.
  const {
    hasProfile, setHasProfile,
    family, setFamily, familyByMeal, setFamilyByMeal, meals, setMeals, diet, setDiet,
    allergies, setAllergies, allergiesAnswered, setAllergiesAnswered, dislikes, setDislikes, cuisines, setCuisines,
    devices, setDevices, maxCookTime, setMaxCookTime, displayName, setDisplayName, mealTimes, setMealTimes,
    toggleSimple, toggleCuisine, profileSnapshot, resetAnswersToDefaults,
  } = useWizardProfile();

  // Слоты планов из localStorage читаем один раз при запуске: они нужны и
  // usePlanStatus (был ли план при запуске), и usePlanSession (начальное состояние).
  const [initialPlanSlots] = useState(loadActivePlanSlots);
  const [step, setStep] = useState(0);
  const [showOtherStores, setShowOtherStores] = useState(false);
  const [openRecipe, setOpenRecipe] = useState(null);
  const [showProModal, setShowProModal] = useState(false);
  // "Ещё один план на этой неделе" — разовая дешёвая покупка, ступенька перед
  // полной подпиской (живой вывод из ревью в чате). Отдельный modal, не режим
  // ProModal — цена/текст/сама механика оплаты (product: "extra_plan")
  // достаточно разные, чтобы не городить условную логику внутри одного
  // большого компонента.
  const [showExtraPlanModal, setShowExtraPlanModal] = useState(false);
  const [showAccount, setShowAccount] = useState(false);

  // Тариф и лимит, семья — в хуках (src/hooks/*). Порядок вызовов хуков = порядок
  // их эффектов при запуске: заявка реферала (useReferral ниже) должна уйти
  // раньше синхронизации плана (эффект submitPlanToBackend) — та создаёт строку
  // пользователя на сервере. Проверяется тестом в App.flows.test.jsx.
  const { planStatus, setPlanStatus, planHistory, setPlanHistory, limitBlocked, setLimitBlocked, lastPlanGate } =
    usePlanStatus({ showAccount, hasLocalPlanAtMount: initialPlanSlots.slots.some((s) => s.id === initialPlanSlots.activeSlotId) });
  const { familyStatus, familyJoinedNote, setFamilyJoinedNote, familyJoinError, setFamilyJoinError, familyActionState, handleCreateFamily, handleLeaveFamily, handleToggleFamilyPantry } =
    useFamily({ showAccount });

  const homeScreenStatus = useHomeScreen();

  // Удаление плана из истории (свайп или кнопка в Аккаунте): сначала сервер, потом список на экране.
  const handleDeletePlan = async (id) => {
    const ok = await deletePlanFromHistory(id);
    if (ok) setPlanHistory((list) => (list ? list.filter((p) => p.id !== id) : list));
    return ok;
  };

  // «Откуда узнали» спрашиваем только новичка (на момент открытия у него не было профиля) и один раз.
  const [isFirstSession] = useState(() => !hasProfile);
  const [acquisitionAsked, setAcquisitionAsked] = useState(loadAcquisitionAnswered);
  const finishAcquisition = (option) => {
    if (option) trackEvent(option.event, { start: startParamKind(window.Telegram?.WebApp?.initDataUnsafe?.start_param) });
    saveAcquisitionAnswered();
    setAcquisitionAsked(true);
  };

  // "Открыли приложение" — раз за сессию, не при каждом ререндере.
  useEffect(() => {
    trackEvent("app_opened", { has_profile: hasProfile, start: startParamKind(window.Telegram?.WebApp?.initDataUnsafe?.start_param) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { referralStatus, referralNote, setReferralNote, invitedByFriend } = useReferral({ showAccount });
  // Строка «Запомнили: …» под первым планом — один раз, пока человек её не закроет.
  const [profileNote, setProfileNote] = useState(null);

  // Слоты, сборка плана, повтор цен, засчитывание и синхронизация — usePlanSession.
  // Вызывается ПОСЛЕ useReferral (см. комментарий у usePlanStatus выше).
  const {
    planSlots, planSlotId, store, setStore, planCreatedAt, budget, setBudget, done, assembling, retryingPrices, generationPending, catalogReason, priceRetryFailed, handleRetryPrices, recomposeNote, setRecomposeNote, planView, autoPriceRetryPending, canAddPlanSlot, handleFinish, swapMeal, handleNewPlan, switchToSlot, removeSlot, startNewPlanSlot, planToReturnTo, handleBackToPlan,
  } = usePlanSession({
    initialPlanSlots,
    family, familyByMeal, planStatus, mealTimes, setLimitBlocked, meals, setShowAccount, diet, cuisines, devices, allergies, dislikes, maxCookTime, hasProfile, profileSnapshot, setHasProfile, setProfileNote, setStep, setOpenRecipe, resetAnswersToDefaults,
  });

  // Подарок приглашённому: узнаём, что за первый план ему начислен Pro, и говорим об этом.
  const giftUntil = useReferralGift({ invitedByFriend, planReady: done && !!planView, onStatus: setPlanStatus });
  const [giftNoteClosed, setGiftNoteClosed] = useState(false);
  const [inviteBannerClosed, setInviteBannerClosed] = useState(false);

  // Известный баг части Android-WebView (в т.ч. внутри Telegram Mini App) —
  // после программного обновления DOM (без тач-события от пользователя)
  // экран не перерисовывается сразу: кадр готов внутри WebView, но не
  // "запаяснен" на экран, пока пользователь не коснётся его пальцем/не
  // проскроллит — это и триггерит перерисовку, которую WebView иначе
  // откладывает. Жалоба в чате: именно на переходе в состояние "собираем
  // список" и обратно, где контент меняется полностью и программно.
  // Форсируем reflow вручную на каждый такой переход.
  useEffect(() => {
    const el = document.documentElement;
    el.style.transform = "translateZ(0)";
    void el.offsetHeight; // синхронно форсирует reflow — без чтения layout-свойства присвоение transform выше могло бы быть "отложено" браузером
    const raf = requestAnimationFrame(() => {
      el.style.transform = "";
    });
    return () => cancelAnimationFrame(raf);
  }, [assembling, done]);

  const [theme, setTheme] = useTheme();

  // У вернувшегося пользователя (есть сохранённый профиль) визард
  // схлопывается до "Магазин" + "Бюджет" — остальное уже известно и
  // редактируется через Аккаунт, а не проходится заново на каждую неделю.
  const activeSteps = useMemo(
    () => (hasProfile ? STEP_META.filter((s) => QUICK_STEP_KEYS.includes(s.key)) : STEP_META),
    [hasProfile]
  );
  const currentStepKey = activeSteps[step]?.key;

  const canNextByKey = {
    store: !!store,
    family: family > 0,
    meals: meals.length > 0,
    budget: budget >= 500,
    diet: !!diet,
    allergies: allergiesAnswered || allergies.length > 0, // нужен ЯВНЫЙ ответ (см. allergiesAnswered)
  };


  const handleSaveProfile = () => {
    hapticNotify("success");
    saveProfile(profileSnapshot());
    // Раньше время приёмов пищи долетало до сервера напоминаний ТОЛЬКО вместе
    // с целым планом (см. useEffect ниже на submitPlanToBackend) — если
    // открыть Аккаунт и поменять время, не пересобирая план заново в этой же
    // сессии, новое время никогда не сохранялось на сервере, и напоминания
    // продолжали приходить по старому времени. Обновляем его отдельно и
    // сразу же, best-effort — как и всё остальное здесь, без бэкенда просто
    // ничего не произойдёт.
    updateMealTimes(mealTimes);
  };
  const handleClearProfile = () => {
    clearProfile();
    // Все слоты плана тоже завязаны на профиль (техника/аллергии/рацион, под
    // которые они собирались) — оставлять их при полном сбросе профиля
    // значило бы после сброса всё равно увидеть старые планы, будто ничего
    // не изменилось. Полный сброс (не "Заново" — тот трогает только один
    // слот, см. reset()).
    clearAllActivePlans();
    // после сброса про профиль приложение узнает заново только при перезагрузке
    // (hasProfile вычислен один раз при монтировании) — это ок, простое и
    // предсказуемое поведение, не тянет за собой сложную ре-синхронизацию стейта
    window.location.reload();
  };

  return (
    <div style={styles.page} className="mp-page">
      <style>{GLOBAL_CSS}</style>

      <div style={styles.card} className="mp-card">
        <div style={styles.header}>
          <div>
            <div style={styles.brandRow}>
              {/* Раньше тут была generic-иконка корзины + функциональная подпись
                  "Список на неделю" — узнаваемого бренда в этом не было, приложение
                  выглядело как безымянный виджет. Теперь — настоящий логотип (тот
                  же образ дымящейся миски, что уже на аватарке @s_edim_bot) плюс
                  название — шапка сразу говорит "это Съедим", а не описывает
                  функцию, которую и так видно по контенту ниже. */}
              <img src={logoUrl} alt="" style={styles.logoMark} />
              <span style={styles.brand}>Съедим</span>
            </div>
            {(displayName || tgFirstName) && (
              <div style={styles.greeting} className="greeting-fade">Привет, {displayName || tgFirstName} 👋</div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {done && !showAccount && (
              <button onClick={handleNewPlan} style={styles.resetBtn}>
                <RotateCcw size={14} /> Новый план
              </button>
            )}
            <button
              onClick={() => setShowAccount((v) => !v)}
              style={styles.accountBtn}
              title={showAccount ? "Закрыть аккаунт" : "Аккаунт"}
              aria-label={showAccount ? "Закрыть аккаунт" : "Аккаунт"}
            >
              <Settings size={16} />
            </button>
          </div>
        </div>

        {referralNote && !showAccount && (
          <DismissibleNote tone="info" onClose={() => setReferralNote(false)}>
            Бонус за приглашение действует только для тех, кто открывает «Съедим» впервые, — вы уже пользовались приложением.
          </DismissibleNote>
        )}

        {familyJoinError && !showAccount && (
          <DismissibleNote onClose={() => setFamilyJoinError(null)}>
            Не удалось вступить в семью: {familyJoinError}
          </DismissibleNote>
        )}

        {familyJoinedNote && !showAccount && (
          <DismissibleNote tone="info" onClose={() => setFamilyJoinedNote(false)}>
            Вы вступили в семью: отметки «уже есть дома» в списке покупок теперь общие. Состав семьи — в{" "}
            <button onClick={() => { setFamilyJoinedNote(false); setShowAccount(true); }} style={styles.inlineLinkBtn}>Аккаунте</button>.
          </DismissibleNote>
        )}

        {showAccount && (
          <AccountView
            displayName={displayName} setDisplayName={setDisplayName}
            theme={theme} setTheme={setTheme}
            family={family} setFamily={setFamily}
            familyByMeal={familyByMeal} setFamilyByMeal={setFamilyByMeal}
            meals={meals} setMeals={setMeals}
            diet={diet} setDiet={setDiet}
            allergies={allergies} setAllergies={setAllergies}
            dislikes={dislikes} setDislikes={setDislikes}
            cuisines={cuisines} setCuisines={setCuisines}
            devices={devices} setDevices={setDevices}
            maxCookTime={maxCookTime} setMaxCookTime={setMaxCookTime}
            mealTimes={mealTimes} setMealTimes={setMealTimes}
            toggleSimple={toggleSimple} toggleCuisine={toggleCuisine}
            hasProfile={hasProfile}
            onSave={handleSaveProfile}
            onClear={handleClearProfile}
            onClose={() => setShowAccount(false)}
            onOpenPro={() => { trackEvent("pro_modal_opened"); setShowProModal(true); }}
            homeScreenStatus={homeScreenStatus}
            onAddToHomeScreen={() => { hapticImpact("light"); trackEvent("home_screen_prompted"); promptAddToHomeScreen(); }}
            planStatus={planStatus}
            planHistory={planHistory}
            onDeletePlan={handleDeletePlan}
            referralStatus={referralStatus}
            familyStatus={familyStatus}
            familyActionState={familyActionState}
            onCreateFamily={handleCreateFamily}
            onLeaveFamily={handleLeaveFamily}
          />
        )}

        {!showAccount && limitBlocked && (
          <LimitBlockedView
            nextResetHint={limitBlocked.nextResetHint}
            done={done}
            onOpenExtraPlan={() => setShowExtraPlanModal(true)}
            onOpenPro={() => setShowProModal(true)}
            onBack={() => setLimitBlocked(null)}
          />
        )}

        {!showAccount && !limitBlocked && !done && lastPlanGate && (
          <LastPlanGateView
            latest={lastPlanGate.latest}
            nextResetHint={lastPlanGate.status?.nextResetHint}
            onOpenPro={() => { hapticImpact("light"); trackEvent("pro_modal_opened", { source: "last_plan_gate" }); setShowProModal(true); }}
            onOpenExtraPlan={() => { hapticImpact("light"); trackEvent("extra_plan_modal_opened", { source: "last_plan_gate" }); setShowExtraPlanModal(true); }}
          />
        )}

        {!showAccount && !limitBlocked && !lastPlanGate && !done && !assembling && (
          <div style={styles.progressWrap}>
            {/* Раньше — одна сплошная полоска-заливка. Отдельный сегмент на
                каждый шаг читается яснее ("вот сколько шагов всего, вот сколько
                пройдено") и выглядит менее как generic progress bar с любого
                сайта — мелкая деталь, но из тех, что складываются в ощущение
                "сделано осмысленно", а не типовым компонентом из коробки. */}
            <div style={styles.progressSegments}>
              {activeSteps.map((s, i) => (
                <div key={s.key} style={styles.progressSegment(i <= step)} />
              ))}
            </div>
            <div style={styles.progressLabel}>
              Шаг {step + 1} из {activeSteps.length} · {activeSteps[step]?.label}
            </div>
          </div>
        )}

        {!showAccount && !limitBlocked && !lastPlanGate && assembling && <SkeletonView />}

        {invitedByFriend && !inviteBannerClosed && step === 0 && !showAccount && !limitBlocked && !lastPlanGate && !done && !assembling && (
          <DismissibleNote tone="info" onClose={() => setInviteBannerClosed(true)}>
            🎁 Вас пригласил друг: соберите свой первый план — и вы оба получите по 7 дней Pro бесплатно.
          </DismissibleNote>
        )}

        {!showAccount && !limitBlocked && !lastPlanGate && !done && !assembling && (
          <WizardView
            currentStepKey={currentStepKey}
            hasProfile={hasProfile}
            showOtherStores={showOtherStores}
            store={store}
            setStore={setStore}
            setShowOtherStores={setShowOtherStores}
            setFamily={setFamily}
            family={family}
            familyByMeal={familyByMeal}
            toggleSimple={toggleSimple}
            meals={meals}
            setMeals={setMeals}
            budget={budget}
            setBudget={setBudget}
            setDiet={setDiet}
            diet={diet}
            setAllergies={setAllergies}
            setAllergiesAnswered={setAllergiesAnswered}
            allergiesAnswered={allergiesAnswered}
            allergies={allergies}
            dislikes={dislikes}
            setDislikes={setDislikes}
            step={step}
            planToReturnTo={planToReturnTo}
            handleBackToPlan={handleBackToPlan}
            setStep={setStep}
            activeSteps={activeSteps}
            handleFinish={handleFinish}
            canNextByKey={canNextByKey}
            setShowAccount={setShowAccount}
          />
        )}

        {!showAccount && !limitBlocked && !assembling && done && planView && (
          <PlanSlotsBar
            slots={planSlots.slots}
            activeId={planSlotId}
            onSwitch={switchToSlot}
            onRemove={removeSlot}
            onAdd={startNewPlanSlot}
            canAdd={canAddPlanSlot}
          />
        )}

        {!showAccount && !limitBlocked && !assembling && done && planView && (
          <ResultView
            plan={planView}
            onRebuild={handleFinish}
            generationPending={generationPending}
            catalogReason={catalogReason}
            planStartISO={planCreatedAt}
            storeId={store}
            storeName={STORES.find((s) => s.id === store)?.name}
            budget={budget}
            family={family}
            mealsCount={meals.length}
            diet={diet}
            allergies={allergies}
            onSwap={swapMeal}
            onOpenRecipe={setOpenRecipe}
            onRetryPrices={handleRetryPrices}
            retryingPrices={retryingPrices}
            priceRetryFailed={priceRetryFailed}
            autoPriceRetryPending={autoPriceRetryPending}
            familyPaused={!!familyStatus?.inFamily && familyStatus.active === false}
            familyPantryNames={familyStatus?.inFamily && familyStatus.active !== false ? familyStatus.pantryNames : null}
            onToggleFamilyPantry={familyStatus?.inFamily && familyStatus.active !== false ? handleToggleFamilyPantry : null}
          />
        )}

        {/* Служебные заметки — под планом, а не над ним: на первом экране человек должен видеть блюда (аудит 19.10.2026). */}
        {giftUntil && !giftNoteClosed && !showAccount && !limitBlocked && !assembling && done && planView && (
          <DismissibleNote tone="info" onClose={() => setGiftNoteClosed(true)}>
            🎁 Вам начислено 7 дней Pro — до {formatResetDate(giftUntil)}. Напоминания, несколько планов и общий список на семью уже доступны.
          </DismissibleNote>
        )}

        {recomposeNote && !showAccount && !limitBlocked && !assembling && done && planView && (
          <DismissibleNote tone="info" onClose={() => setRecomposeNote(false)}>
            Настоящие цены загрузились, и мы заново подобрали блюда, чтобы план уложился в ваш бюджет.
          </DismissibleNote>
        )}

        {profileNote && !showAccount && !limitBlocked && !assembling && done && planView && (
          <DismissibleNote tone="info" onClose={() => setProfileNote(null)}>
            Запомнили: {profileNote}. В следующий раз спросим только магазин и бюджет. Изменить — в{" "}
            <button onClick={() => setShowAccount(true)} style={styles.inlineLinkBtn}>Аккаунте</button>.
          </DismissibleNote>
        )}

        {isFirstSession && !acquisitionAsked && !showAccount && !limitBlocked && !assembling && done && planView && (
          <AcquisitionCard onAnswer={finishAcquisition} onClose={() => finishAcquisition(null)} />
        )}

      </div>

      {openRecipe && (
        <RecipeModal dm={openRecipe} family={openRecipe.family ?? family} onClose={() => setOpenRecipe(null)} />
      )}
      {showProModal && <ProModal onClose={() => setShowProModal(false)} />}
      {showExtraPlanModal && (
        <ExtraPlanModal
          onClose={() => setShowExtraPlanModal(false)}
          onOpenPro={() => { setShowExtraPlanModal(false); trackEvent("pro_modal_opened", { source: "extra_plan_modal" }); setShowProModal(true); }}
        />
      )}
    </div>
  );
}

// Публичный экспорт сохранён: его импортирует src/App.share.test.js.
export { buildShareUrl } from "./lib/share.js";
