import { Turtle } from './turtle';
import type { TrackDef } from '../types';

/**
 * NEON CITY — rain-soaked night circuit.
 * Main straight → climbing T1 sweeper onto an elevated expressway → S-bends →
 * long elevated straight → right-hander → ramp hop into a 630 m curving tunnel →
 * plaza hairpin (drift zone) → narrow downtown chicane → canal back straight →
 * final corner.
 */
export function neonCity(): TrackDef {
  const t = new Turtle(0, 0.3, 240, 0, 40);
  t.straight(460);
  t.arc(240, 60, 5); // T1, climbing
  t.begin('elevated');
  t.arc(300, 30, 7);
  t.straight(150, 1);
  t.arc(260, -25, 1);
  t.arc(260, 25);
  t.straight(500);
  t.arc(180, 90, -3);
  t.end('elevated');
  t.begin('jump').straight(150, -11).end('jump'); // ramp down: small hop
  t.begin('tunnel');
  t.arc(400, 20);
  t.straight(350);
  t.arc(400, -20);
  t.end('tunnel');
  t.straight(190);
  t.width(10).straight(30);
  t.begin('plaza').arc(38, 180).end('plaza'); // plaza hairpin
  t.width(9).straight(60);
  t.width(9).arc(70, -90);
  t.straight(30);
  t.width(9).begin('city');
  t.arc(85, -30).arc(85, 60).arc(85, -30); // downtown chicane
  t.end('city');
  t.width(9).straight(40);
  t.width(undefined);
  t.begin('canal', -1);
  t.straight(655.9);
  t.end('canal');
  t.arc(110, 90); // final corner
  t.straight(125.7);
  if (import.meta.env.DEV) console.info('[turtle neon] closure', t.closureError());
  const { points, sections, pads } = t.close();
  return {
    id: 'neon',
    name: 'NEON CITY',
    nameKo: '네온 시티',
    subtitle: '비 내리는 사이버펑크 야경 · 고가도로 · 장터널',
    theme: 'neon',
    points,
    halfWidth: 9,
    autoBank: 20,
    maxBank: 7,
    sections,
    boostPads: pads,
    laps: 3,
    seed: 1107,
    sunDir: [-0.4, 0.8, -0.45],
  };
}
