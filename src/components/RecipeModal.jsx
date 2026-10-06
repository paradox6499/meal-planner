// Окно рецепта (портал в document.body).

import { createPortal } from "react-dom";
import { X, Clock, Clapperboard } from "lucide-react";
import { trackEvent } from "../lib/analytics.js";
import { styles } from "../styles.js";

export function RecipeModal({ dm, family, onClose }) {
  const { recipe, cost, isRealPrice } = dm;
  // Через портал в document.body (скриншот пользователя 04.10.2026: «открываю
  // план из истории — чёрное окно, дальше ничего»). Карточка приложения имеет
  // will-change: transform, а у такого предка position: fixed считается ОТ НЕГО,
  // а не от экрана: оверлей растягивался на всю высоту длинного Аккаунта, окно
  // рецепта оказывалось где-то посередине за пределами видимой части, на экране
  // оставалась только тёмная вуаль. Из ResultView модалка открывалась снаружи
  // карточки и работала — сломаны были история планов и экран "последний план".
  return createPortal((
    <div style={styles.modalOverlay} className="modal-overlay-in" onClick={onClose}>
      <div style={styles.modalCard} className="modal-card-in" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} title="Закрыть" aria-label="Закрыть" style={styles.modalClose}>
          <X size={16} />
        </button>

        {recipe.photoUrl ? (
          <img src={recipe.photoUrl} alt={recipe.name} style={styles.modalHeroPhoto} />
        ) : (
          <div style={styles.modalHero}>{recipe.emoji}</div>
        )}

        <h2 style={{ ...styles.stepTitle, marginBottom: 8 }}>{recipe.name}</h2>
        <div style={styles.modalMeta}>
          <span style={styles.timeBadge}><Clock size={13} /> {recipe.time} мин</span>
          <span>
            {cost == null
              ? `Цена неизвестна — не нашли товар в каталоге`
              : <>{(cost * family).toLocaleString("ru-RU")} ₽ на {family} {family === 1 ? "человека" : "человек"}{!isRealPrice && " (оценочно)"}</>}
          </span>
        </div>

        {/* КБЖУ — запрос в чате "нет учёта КБЖУ". Реальные данные от
            ВкусВилл (raw.nutritional), не у каждого рецепта есть — тогда
            просто не показываем блок, а не выдумываем цифры. На 100 г
            готового блюда (см. комментарий у nutritionPer100g в
            vkusvillRecipes.js), не пересчитываем на порцию/family — это
            справочная характеристика самого блюда, не факта "сколько купить". */}
        {recipe.nutritionPer100g && (
          <div style={{ ...styles.modalMeta, marginTop: -10 }}>
            <span>🔥 {Math.round(recipe.nutritionPer100g.calories)} ккал</span>
            <span>Б {Math.round(recipe.nutritionPer100g.protein)} г</span>
            <span>Ж {Math.round(recipe.nutritionPer100g.fat)} г</span>
            <span>У {Math.round(recipe.nutritionPer100g.carbs)} г</span>
            <span style={{ color: "var(--text-tertiary)" }}>на 100 г</span>
          </div>
        )}

        <h3 style={styles.sectionTitle}>Ингредиенты</h3>
        <div style={{ ...styles.listBox, marginBottom: 18 }}>
          {recipe.ingr.map(([name, amount, unit]) => (
            <div key={name} style={styles.listRow}>
              <span>{name}</span>
              <span style={{ color: "var(--text-tertiary)" }}>{Math.round(amount * family)} {unit}</span>
            </div>
          ))}
        </div>

        <h3 style={styles.sectionTitle}>Приготовление</h3>
        <ol style={styles.stepsList}>
          {recipe.steps.map((step, i) => (
            <li key={i} style={styles.stepItem}>{step}</li>
          ))}
        </ol>

        {/* Запрос в чате: "что делать, если человек хочет готовить по видео,
            а не по тексту". ВкусВилл видео не отдаёт вообще (проверено
            вживую через их же MCP — в ответе нет ни одного поля с видео),
            записывать/лицензировать своё — совсем другой по объёму проект.
            Компромисс: честная поисковая ссылка на YouTube по названию
            блюда — не обещаем, что видео точно найдётся или совпадёт с
            рецептом один в один, просто даём быстрый путь поискать самому. */}
        <a
          href={`https://www.youtube.com/results?search_query=${encodeURIComponent(`${recipe.name} рецепт`)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={styles.videoSearchLink}
          onClick={() => trackEvent("recipe_video_search_clicked")}
        >
          <Clapperboard size={14} /> Найти видео-рецепт на YouTube
        </a>
      </div>
    </div>
  ), document.body);
}
