import { Component } from "react";
import { trackEvent } from "./lib/analytics.js";

// Ловит ЛЮБУЮ необработанную ошибку рендера в дереве ниже — без этого
// сломанный компонент (например, из-за неожиданного ответа VkusVill: сами же
// пометили ID таксономии и форму ответа как "не гарантированно вечные" —
// см. vkusvillRecipes.js) роняет весь экран в белый/чёрный без единой
// подсказки, что случилось и что делать. Класс-компонент — единственный
// способ поймать ошибку рендера в React, хуков для этого нет.
//
// Стили — inline и НЕ завязаны на CSS-переменные из App.jsx (--text-primary
// и т.п.): если что-то упало ДО того, как основной <style> внутри
// MealPlanner успел примонтироваться, этот экран всё равно должен выглядеть
// нормально, а не голым нестилизованным текстом.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // В консоль — чтобы было что скопировать в багрепорт локально. И (best
    // effort, см. lib/analytics.js) на бэкенд — то самое "как понять, что у
    // пользователей что-то не так", без этого раздел "Технические детали"
    // ниже увидел бы только сам пользователь, а разработчик — никогда.
    console.error("ErrorBoundary поймал ошибку рендера:", error, info.componentStack);
    trackEvent("app_error", { message: String(error?.message || error).slice(0, 300) });
  }

  // Просто reload решает подавляющее большинство случаев (ошибка была
  // разовой — например, единичный сбой сети или неожиданная форма ответа
  // VkusVill на этот конкретный запрос). Отдельная кнопка ниже — на случай,
  // когда причина сидит в localStorage (например, будущий баг испортит
  // сохранённый профиль) и обычный reload зациклится на той же ошибке.
  handleReload = () => window.location.reload();
  handleResetProfile = () => {
    try {
      localStorage.removeItem("sedim.profile.v1");
      localStorage.removeItem("sedim.theme.v1");
    } catch {
      /* приватный режим браузера — просто перезагружаем, хуже не будет */
    }
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={styles.emoji}>😕</div>
          <h2 style={styles.title}>Что-то пошло не так</h2>
          <p style={styles.text}>Приложение столкнулось с неожиданной ошибкой. Обычно помогает просто начать заново.</p>
          <button onClick={this.handleReload} style={styles.button}>Начать заново</button>
          <button onClick={this.handleResetProfile} style={styles.linkButton}>
            Не помогло — сбросить сохранённые настройки
          </button>
          <details style={styles.details}>
            <summary style={styles.summary}>Технические детали</summary>
            <pre style={styles.pre}>{String(this.state.error?.stack || this.state.error)}</pre>
          </details>
        </div>
      </div>
    );
  }
}

const styles = {
  page: {
    minHeight: "100dvh", width: "100%", display: "flex", alignItems: "center", justifyContent: "center",
    background: "#0b0b0d", color: "#f2f2f7",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', Arial, sans-serif",
    padding: 24, boxSizing: "border-box",
  },
  card: {
    maxWidth: 380, width: "100%", textAlign: "center", background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.1)", borderRadius: 24, padding: "32px 24px", boxSizing: "border-box",
  },
  emoji: { fontSize: 40, marginBottom: 12 },
  title: { fontSize: 19, fontWeight: 700, margin: "0 0 8px 0" },
  text: { fontSize: 14, color: "#b6b6bb", lineHeight: 1.5, margin: "0 0 20px 0" },
  button: {
    display: "block", width: "100%", background: "linear-gradient(180deg, #0A84FF, #0066DB)", border: "none",
    color: "#fff", fontSize: 14.5, fontWeight: 600, padding: "13px 24px", borderRadius: 999, cursor: "pointer",
  },
  linkButton: {
    display: "block", width: "100%", background: "none", border: "none", color: "#8e8e93",
    fontSize: 12.5, cursor: "pointer", padding: "12px 4px 0 4px", textDecoration: "underline",
  },
  details: { marginTop: 20, textAlign: "left" },
  summary: { fontSize: 12, color: "#8e8e93", cursor: "pointer" },
  pre: {
    fontSize: 11, color: "#8e8e93", whiteSpace: "pre-wrap", wordBreak: "break-word",
    background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: 10, marginTop: 8, maxHeight: 200, overflow: "auto",
  },
};
