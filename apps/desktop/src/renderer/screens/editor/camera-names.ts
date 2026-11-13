import type { Vec2 } from '@zeyvola/project-model';
import { t } from '../../i18n';

/** Spoken name of a spot in the frame on a 3×3 grid ("Sağ alt", "Üst orta", …). */
export function placeName(p: Vec2): string {
  const col = p.x < 0.36 ? 0 : p.x > 0.64 ? 2 : 1;
  const row = p.y < 0.36 ? 0 : p.y > 0.64 ? 2 : 1;
  const names = [
    [t("Sol üst"), t("Üst orta"), t("Sağ üst")],
    [t("Sol"), t("Orta"), t("Sağ")],
    [t("Sol alt"), t("Alt orta"), t("Sağ alt")],
  ];
  return names[row]![col]!;
}

/** Cell centres of the 3×3 position picker, row by row. */
export const PLACE_GRID: Vec2[] = [0.2, 0.5, 0.8].flatMap((y) => [0.12, 0.5, 0.885].map((x) => ({ x, y })));
