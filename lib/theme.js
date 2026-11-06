"use client";

export const THEME_KEY = "solace_theme_mode";
export const SCHEDULE_KEY = "solace_theme_schedule";

export const THEME_MODES = [
  {
    id: "day",
    title: "晨光浅杏",
    badge: "白天明亮",
    subtitle: "温润米白底与陶红点缀，适合日间光线充足时使用",
    icon: "☀️",
  },
  {
    id: "night",
    title: "深宵暖咖",
    badge: "深夜暗光",
    subtitle: "暖深炭褐配琥珀微光，专为深夜熄灯后的床头倾诉打造，柔和护眼",
    icon: "☕",
  },
  {
    id: "system",
    title: "随光而变",
    badge: "系统自适应",
    subtitle: "紧随设备操作系统的深浅色模式自动流转切换",
    icon: "🌗",
  },
  {
    id: "schedule",
    title: "定时刻度",
    badge: "自动守候",
    subtitle: "在每日指定时段自动切换为深宵暖咖，给长夜恒常的温柔守护",
    icon: "⏳",
  },
];

export const DEFAULT_SCHEDULE = {
  start: "20:00",
  end: "07:00",
};

/**
 * 判断当前时刻在指定起止时间跨度内是否命中
 */
export function isTimeInSchedule(startStr = "20:00", endStr = "07:00") {
  try {
    const now = new Date();
    const curMin = now.getHours() * 60 + now.getMinutes();

    const [sH, sM] = (startStr || "20:00").split(":").map(Number);
    const [eH, eM] = (endStr || "07:00").split(":").map(Number);

    const sMin = (Number.isFinite(sH) ? sH : 20) * 60 + (Number.isFinite(sM) ? sM : 0);
    const eMin = (Number.isFinite(eH) ? eH : 7) * 60 + (Number.isFinite(eM) ? eM : 0);

    // 跨天（例如 20:00 到次日 07:00）
    if (sMin > eMin) {
      return curMin >= sMin || curMin < eMin;
    }
    // 当日区间（例如 18:00 到 23:00）
    return curMin >= sMin && curMin < eMin;
  } catch {
    return false;
  }
}

/**
 * 读取当前存储的主题模式与定时刻度
 */
export function getStoredTheme() {
  if (typeof window === "undefined") {
    return { mode: "day", schedule: DEFAULT_SCHEDULE };
  }
  try {
    const mode = localStorage.getItem(THEME_KEY) || "day";
    const rawSch = localStorage.getItem(SCHEDULE_KEY);
    const schedule = rawSch ? { ...DEFAULT_SCHEDULE, ...JSON.parse(rawSch) } : DEFAULT_SCHEDULE;
    return { mode, schedule };
  } catch {
    return { mode: "day", schedule: DEFAULT_SCHEDULE };
  }
}

/**
 * 计算实际是否应该处于深宵暖咖（暗光）状态
 */
export function resolveIsEspresso(mode, schedule = DEFAULT_SCHEDULE) {
  if (typeof window === "undefined") return false;
  if (mode === "night") return true;
  if (mode === "day") return false;
  if (mode === "system") {
    return !!window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  }
  if (mode === "schedule") {
    return isTimeInSchedule(schedule.start, schedule.end);
  }
  return false;
}

/**
 * 应用并持久化主题
 */
export function applyTheme(mode, schedule = DEFAULT_SCHEDULE) {
  if (typeof window === "undefined") return false;

  try {
    localStorage.setItem(THEME_KEY, mode);
    localStorage.setItem(SCHEDULE_KEY, JSON.stringify(schedule));
  } catch {}

  const isDark = resolveIsEspresso(mode, schedule);
  const root = document.documentElement;

  if (isDark) {
    root.setAttribute("data-theme", "espresso");
    root.classList.add("theme-espresso");
    root.classList.add("dark");
  } else {
    root.removeAttribute("data-theme");
    root.classList.remove("theme-espresso");
    root.classList.remove("dark");
  }

  // 通知外部关注主题变化的组件
  try {
    window.dispatchEvent(
      new CustomEvent("solace-theme-change", {
        detail: { mode, schedule, isDark },
      })
    );
  } catch {}

  return isDark;
}

