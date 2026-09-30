import { Turtle } from './turtle';
import type { TrackDef } from '../types';

/**
 * SUNSET COAST — synthwave golden hour on a clifftop island circuit.
 * Clockwise triangle (the sea is always on the driver's left):
 * seaside boulevard straight into the setting sun → climbing S-sweepers onto
 * the cliffs → blind crest jump → clifftop right-hander above the waves →
 * downhill S onto a 730 m suspension bridge across the bay → curving tunnel
 * through the headland → fast downhill sweepers → lighthouse hairpin →
 * beachfront back straight → final corner back into the sun.
 */
export function sunsetCoast(): TrackDef {
  const t = new Turtle(0, 2, 0, 0, 40);
  // 1) Seaside boulevard (the grid sits on the last 150 m of the lap, below).
  t.begin('beach', -1);
  t.straight(659.3);
  t.end('beach');
  // 2) Fast S-sweepers climbing onto the cliffs (net heading 0: still into the sun).
  t.arc(380, 24, 6);
  t.straight(70, 6);
  t.arc(380, -24, 8);
  // 3) Clifftop: blind crest (lift-off ~0.6 s at 260 km/h, ~1.3 s at 320 km/h,
  //    soft landing on the down-ramp), braking zone, then the medium right-hander.
  t.begin('cliff', -1);
  t.straight(110, 8);
  t.begin('jump').straight(80, 3.5, 10).straight(190, -6, 10).end('jump');
  t.straight(100);
  t.arc(115, 120);
  t.end('cliff');
  // 4) Downhill S onto the suspension bridge (~22 m above the bay). The 360 m
  //    main span between the towers is straight; the side spans curve gently.
  t.arc(210, 50, -3);
  t.arc(210, -20, -3);
  t.begin('bridge');
  t.arc(1500, 7, 0.8);
  t.straight(180, 1.2, 30);
  t.straight(180, -1.2, 30);
  t.arc(1500, 7, -0.8);
  t.end('bridge');
  // 5) Curving tunnel through the headland (exit hidden until the last 200 m).
  t.begin('tunnel');
  t.arc(700, -14);
  t.straight(200, 1);
  t.end('tunnel');
  // 6) Fast downhill sweepers back to sea level.
  t.arc(330, 30, -9);
  t.arc(330, -30, -9);
  t.straight(80, -1.5); // the rocky point stays 3 m up: the banked hairpin kerb clears the sea
  // 7) Left kink, then the lighthouse hairpin on the rocky point.
  t.arc(220, -30);
  t.straight(60);
  t.begin('lighthouse', -1).arc(40, 140).end('lighthouse');
  t.straight(70);
  // 8) Beachfront back straight → final corner → start.
  t.begin('beach', -1);
  t.straight(811.9, -1);
  t.end('beach');
  t.arc(190, 100);
  t.straight(150);
  if (import.meta.env.DEV) console.info('[turtle coast] closure', t.closureError());
  const { points, sections, pads } = t.close();
  return {
    id: 'coast',
    name: 'SUNSET COAST',
    nameKo: '선셋 코스트',
    subtitle: '노을 지는 해안 절벽 · 점프 · 현수교 · 등대 헤어핀',
    theme: 'coast',
    points,
    halfWidth: 10.5,
    autoBank: 20,
    maxBank: 8,
    sections,
    boostPads: pads,
    laps: 3,
    seed: 5150,
    // Warm key light from the setting sun (north-north-west, ~16° high).
    sunDir: [-0.329, 0.276, -0.903],
  };
}
