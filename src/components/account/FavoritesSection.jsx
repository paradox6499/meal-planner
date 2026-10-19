// Раздел «Избранное» в Аккаунте: рецепты, которые человек отметил сердечком. Хранятся на устройстве (lib/recipeBook.js).
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { hapticSelect } from "../../lib/haptics.js";
import { styles, T } from "../../styles.js";
import { useRecipeBook, totalCooked } from "../../lib/recipeBook.js";
import { RecipeModal } from "../RecipeModal.jsx";

// Сколько избранного видно сразу; остальное — по кнопке (раздел не должен уводить настройки далеко вниз).
export const FAVORITES_VISIBLE_DEFAULT = 3;

export function FavoritesSection({ family }) {
  const book = useRecipeBook();
  const [showAll, setShowAll] = useState(false);
  const [openRecipe, setOpenRecipe] = useState(null);
  const cookedTotal = totalCooked(book);
  if (book.favorites.length === 0 && cookedTotal === 0) return null;

  const visible = showAll ? book.favorites : book.favorites.slice(0, FAVORITES_VISIBLE_DEFAULT);
  const hidden = Math.max(0, book.favorites.length - FAVORITES_VISIBLE_DEFAULT);

  return (
    <div style={styles.acctSection}>
      <div style={styles.acctSectionTitle}>Избранное</div>
      <p style={styles.acctSectionHint}>
        Рецепты с сердечком
        {cookedTotal > 0 ? ` · всего приготовлено: ${cookedTotal}` : ""}
        . Хранятся на этом устройстве.
      </p>
      <div style={styles.stack}>
        {visible.map((f) => (
          <button
            key={f.key}
            className="chip"
            onClick={() => { hapticSelect(); setOpenRecipe({ recipe: f.recipe, cost: f.cost, isRealPrice: false, family }); }}
            style={styles.rowChip(false)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <span style={{ fontSize: T.title }}>{f.recipe.emoji || "🍽"}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{f.recipe.name}</div>
                {f.recipe.time != null && <div style={styles.chipHint}>{f.recipe.time} мин</div>}
              </div>
            </div>
            <ChevronRight size={16} />
          </button>
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => { hapticSelect(); setShowAll((v) => !v); }}
            style={{ ...styles.inlineLinkBtn, padding: "10px 0", minHeight: 44, alignSelf: "flex-start", fontSize: T.caption }}
          >
            {showAll ? "Свернуть" : `Показать ещё ${hidden}`}
          </button>
        )}
      </div>
      {openRecipe && <RecipeModal dm={openRecipe} family={openRecipe.family} onClose={() => setOpenRecipe(null)} />}
    </div>
  );
}
