import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  StatusBar,
  Alert,
  Animated,
  Easing,
  BackHandler,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';

// ---------------------------------------------------------------------------
// Theme: Old World blue & gold
// ---------------------------------------------------------------------------
const C = {
  bg: '#0A1730',
  panel: '#12264A',
  panel2: '#1B3668',
  line: '#2F4E8E',
  gold: '#D4AF37',
  goldLight: '#F0D57A',
  goldDark: '#8F6F18',
  text: '#F4ECD3',
  muted: '#9FB3D9',
  danger: '#E0705C',
  good: '#8EDDB0',
};

// ---------------------------------------------------------------------------
// Official Victory Point rules (Warhammer: The Old World)
// ---------------------------------------------------------------------------
const STANDARD_VP = 50; // per enemy standard claimed as a trophy
const GENERAL_VP = 100; // enemy General slain / fled off / fleeing at end
const BSB_VP = 50; // enemy Battle Standard Bearer slain / fled off / fleeing at end

type UnitStatus = 'alive' | 'reduced' | 'fleeing' | 'destroyed';

const STATUSES: { key: UnitStatus; label: string; mult: number; color: string }[] = [
  { key: 'alive', label: 'Alive', mult: 0, color: C.line },
  { key: 'reduced', label: '≤25%', mult: 0.5, color: '#B7791F' },
  { key: 'fleeing', label: 'Fleeing', mult: 0.5, color: '#C0561F' },
  { key: 'destroyed', label: 'Dead / fled', mult: 1, color: '#B83A2E' },
];
const MULT: Record<UnitStatus, number> = Object.fromEntries(STATUSES.map((s) => [s.key, s.mult])) as Record<UnitStatus, number>;

const unitVP = (u: Unit): number => Math.ceil(u.points * MULT[u.status]); // fractions round up

const isGone = (u: Unit): boolean => u.status === 'destroyed' || u.status === 'fleeing';

// Victory Points Table: VP difference (rows) against size of game, points per side (columns)
type VPResult = 'D' | 'MV' | 'RV' | 'CV';
type ResultCode = VPResult | 'V'; // 'V' = plain victory under core rulebook scoring
type Scoring = 'matched' | 'core';
const SCORING_OPTIONS: { key: Scoring; label: string }[] = [
  { key: 'matched', label: 'Matched play' },
  { key: 'core', label: 'Core rulebook' },
];
const DEFAULT_SCORING: Scoring = 'matched';
const SIZES = ['Up to 1,000', '1,001–1,500', '1,501–2,000', '2,001–3,000', '3,001+'];
const DEFAULT_SIZE = 2;
const RESULT_NAME: Record<ResultCode, string> = {
  D: 'Draw',
  MV: 'Marginal victory',
  RV: 'Resounding victory',
  CV: 'Crushing victory',
  V: 'Victory',
};
const VP_TABLE: { max: number; label: string; results: VPResult[] }[] = [
  { max: 100, label: '0–100', results: ['D', 'D', 'D', 'D', 'D'] },
  { max: 200, label: '101–200', results: ['MV', 'D', 'D', 'D', 'D'] },
  { max: 300, label: '201–300', results: ['MV', 'MV', 'D', 'D', 'D'] },
  { max: 450, label: '301–450', results: ['RV', 'MV', 'MV', 'D', 'D'] },
  { max: 600, label: '451–600', results: ['RV', 'MV', 'MV', 'MV', 'D'] },
  { max: 750, label: '601–750', results: ['RV', 'RV', 'MV', 'MV', 'MV'] },
  { max: 950, label: '751–950', results: ['CV', 'RV', 'RV', 'MV', 'MV'] },
  { max: 1150, label: '951–1,150', results: ['CV', 'RV', 'RV', 'RV', 'MV'] },
  { max: 1400, label: '1,151–1,400', results: ['CV', 'CV', 'RV', 'RV', 'RV'] },
  { max: 1700, label: '1,401–1,700', results: ['CV', 'CV', 'CV', 'RV', 'RV'] },
  { max: 2500, label: '1,701–2,500', results: ['CV', 'CV', 'CV', 'CV', 'RV'] },
  { max: Infinity, label: '2,501+', results: ['CV', 'CV', 'CV', 'CV', 'CV'] },
];

const sizeForPoints = (p: number): number => (p <= 1000 ? 0 : p <= 1500 ? 1 : p <= 2000 ? 2 : p <= 3000 ? 3 : 4);

const STORAGE_KEY = 'tow-scorer-game-v1';
const HISTORY_KEY = 'tow-scorer-history-v1';
const MAX_TEXT_LENGTH = 20000;

type ManualScore = {
  kills: string;
  standards: string;
  general: boolean;
  bsb: boolean;
  scenario: string;
  secondary: string;
};

type Unit = {
  id: string;
  name: string;
  points: number;
  status: UnitStatus;
  standard: boolean;
  equipment: string[];
  isGeneral: boolean;
  isBSB: boolean;
};

type DraftEntry = {
  name: string;
  text: string;
};

type PlayerState = {
  name: string;
  units: Unit[];
};

type GameState = {
  mode: 'two' | 'single';
  players: [PlayerState, PlayerState];
  manual: [ManualScore, ManualScore];
  recordedId: string | null;
  sizeIdx?: number; // index into SIZES (missing on games saved by older versions)
  scoring?: Scoring; // missing on older saves, which used matched play
};

type HistoryEntry = {
  id: string;
  date: string;
  mode: 'two' | 'single';
  names: [string, string];
  scores: [number, number];
  result: 'win' | 'loss' | 'draw';
  title: string;
  size?: string;
  scoring?: Scoring;
};

const readClipboard = async (): Promise<string> => {
  const text = await Clipboard.getStringAsync();
  return typeof text === 'string' ? text.slice(0, MAX_TEXT_LENGTH).trim() : '';
};

function safeParseJson<T>(raw: string | null, fallback: T, validator: (value: unknown) => boolean): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validator(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

const isValidGame = (value: unknown): boolean =>
  !!value &&
  typeof value === 'object' &&
  Array.isArray((value as { players?: unknown }).players) &&
  Array.isArray((value as { manual?: unknown }).manual) &&
  (value as { players: unknown[] }).players.length >= 2 &&
  (value as { manual: unknown[] }).manual.length >= 2;

const isValidHistory = (value: unknown): boolean =>
  Array.isArray(value) && value.every((entry) => !!entry && typeof entry === 'object');

const num = (v: string): number => parseInt(v, 10) || 0;
const newManual = (): ManualScore => ({
  kills: '',
  standards: '',
  general: false,
  bsb: false,
  scenario: '',
  secondary: '',
});
const blankDraft = (): DraftEntry[] => [
  { name: '', text: '' },
  { name: '', text: '' },
];

// ---------------------------------------------------------------------------
// List parsing
// ---------------------------------------------------------------------------
let uid = 0;
const BULLET = /^[-•*+·–]/;
const CATEGORY = /^(characters?|lords?|heroes|core( units)?|special( units)?|rare( units)?|mercenaries|allies)$/i;

// Ways people write points, tried in order. Handles exported lists and hand-typed ones:
//   "225 pts", "225pts", "225 points", "225p", "225 p", "(225p)", "[225 pts]",
//   "pts: 225", "Greatswords (225)", "Greatswords - 225"
const POINTS_PATTERNS: RegExp[] = [
  /(\d[\d,]*)\s*(?:pts?\.?|points?|p)(?![a-z0-9])/i,
  /(?:pts?|points?)\s*[:=]\s*(\d[\d,]*)/i,
  /[\[(]\s*(\d[\d,]*)\s*[\])]\s*$/,
  /[-–:=|,]\s*(\d{2,4})\s*$/,
];

function extractPoints(line: string): { points: number; rest: string } | null {
  for (const re of POINTS_PATTERNS) {
    const m = line.match(re);
    if (m) {
      const points = parseInt(m[1].replace(/,/g, ''), 10);
      if (!Number.isNaN(points)) return { points, rest: line.replace(m[0], ' ') };
    }
  }
  return null;
}

function parseList(text: string, side: number): Unit[] {
  const units: Unit[] = [];
  const lines = text.split(/\r?\n/);
  let firstMatch = true;
  let lastIndent = 0;

  // A hand-typed list may bullet every unit ("- Greatswords 225p"). If no plain line
  // (other than an army header) carries points, treat bulleted lines as units.
  const plain = lines
    .map((l) => l.trim())
    .filter((t) => t && !BULLET.test(t) && !/total/i.test(t))
    .map((t) => extractPoints(t))
    .filter((p): p is { points: number; rest: string } => p !== null);
  const bulletsAreUnits = plain.filter((p, i) => !(i === 0 && p.points >= 750)).length === 0;

  lines.forEach((raw) => {
    const line = raw.trim();
    if (!line || /total/i.test(line)) return;

    const indent = (raw.match(/^[\t ]*/)?.[0] ?? '').replace(/\t/g, '    ').length;
    const last = units[units.length - 1];
    const isBullet = BULLET.test(line);

    // Bullet lines, and lines indented deeper than the unit line, are that unit's
    // equipment/options (their cost is already inside the unit's own points).
    // They are also searched for General / Battle Standard Bearer markers.
    if (!bulletsAreUnits && (isBullet || (last && indent > lastIndent))) {
      if (last) {
        const item = line.replace(/^[-•*+·–]+\s*/, '').trim();
        if (item) last.equipment.push(item);
        if (/\bgeneral\b/i.test(line)) last.isGeneral = true;
        if (/battle standard|\bBSB\b/i.test(line)) last.isBSB = true;
      }
      return;
    }

    const content = isBullet ? line.replace(/^[-•*+·–]+\s*/, '') : line;
    const found = extractPoints(content);
    if (!found) return;
    const points = found.points;

    const name = found.rest
      .replace(/^\s*\d+[.)]\s+/, '') // list numbering: "1. Greatswords", "2) Pistoliers"
      .replace(/[\[\]()]/g, '')
      .replace(/[-–:=,|]+\s*$/, '')
      .replace(/^\s*[-–:=,|]+/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!name) return;

    // Category headings that carry a points total ("Characters [450 pts]")
    if (CATEGORY.test(name)) return;

    // First matched line is normally the army header ("Empire of Man - 2000 pts")
    if (firstMatch && points >= 750) {
      firstMatch = false;
      return;
    }
    firstMatch = false;

    uid += 1;
    units.push({
      id: `${side}-${uid}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      points,
      status: 'alive',
      standard: false, // enemy has claimed this unit's standard
      equipment: [],
      isGeneral: /\bgeneral\b/i.test(content),
      isBSB: /battle standard|\bBSB\b/i.test(content),
    });
    lastIndent = indent;
  });

  return units;
}

// ---------------------------------------------------------------------------
// Score sheet: how many VP does side `s` score?
// ---------------------------------------------------------------------------
function buildSheet(game: GameState, s: number) {
  const enemy = game.players[1 - s];
  const man = game.manual[s];
  const auto = enemy.units.length > 0; // enemy list available -> calculate automatically

  let kills;
  let standards;
  let general;
  let bsb;
  if (auto) {
    kills = enemy.units.reduce((t, u) => t + unitVP(u), 0);
    standards = enemy.units.filter((u) => u.standard).length;
    general = enemy.units.some((u) => u.isGeneral && isGone(u));
    bsb = enemy.units.some((u) => u.isBSB && isGone(u));
  } else {
    kills = num(man.kills);
    standards = num(man.standards);
    general = man.general;
    bsb = man.bsb;
  }

  const standardsVP = standards * STANDARD_VP;
  const generalVP = general ? GENERAL_VP : 0;
  const bsbVP = bsb ? BSB_VP : 0;
  const scenario = num(man.scenario);
  const secondary = num(man.secondary);
  const total = kills + standardsVP + generalVP + bsbVP + scenario + secondary;

  return { auto, kills, standards, standardsVP, general, generalVP, bsb, bsbVP, scenario, secondary, total };
}

// Matched play: the result comes from the Victory Points Table for this size of game.
// Core rulebook: win by 100+ VP, crushing victory at twice the opponent's VP, anything else is a draw.
function outcome(
  a: number,
  b: number,
  nameA: string,
  nameB: string,
  sizeIdx: number,
  scoring: Scoring
): { code: ResultCode; title: string; sub: string } {
  const diff = Math.abs(a - b);
  const winner = a > b ? nameA : nameB;

  if (scoring === 'core') {
    if (diff < 100) return { code: 'D', title: 'Draw', sub: `${diff} VP apart (a win needs 100+) · Core rules` };
    const code: ResultCode = Math.max(a, b) >= Math.min(a, b) * 2 ? 'CV' : 'V';
    return { code, title: `${RESULT_NAME[code]}: ${winner}`, sub: `Won by ${diff} VP · Core rules` };
  }

  const row = VP_TABLE.find((r) => diff <= r.max) ?? VP_TABLE[VP_TABLE.length - 1];
  const code: ResultCode = row.results[sizeIdx] ?? 'D';
  const sizeLabel = `${SIZES[sizeIdx] ?? SIZES[DEFAULT_SIZE]} pts`;
  if (code === 'D') return { code, title: 'Draw', sub: `${diff} VP apart in a ${sizeLabel} game` };
  return { code, title: `${RESULT_NAME[code]}: ${winner}`, sub: `Won by ${diff} VP · ${sizeLabel} game` };
}

// ---------------------------------------------------------------------------
// Splash animation
// ---------------------------------------------------------------------------
function Splash({ onDone }: { onDone: () => void }) {
  // Keep the latest callback in a ref so parent re-renders never restart the animation.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const ring = useMemo(() => new Animated.Value(0), []);
  const spin = useMemo(() => new Animated.Value(0), []);
  const title = useMemo(() => new Animated.Value(0), []);
  const bar = useMemo(() => new Animated.Value(0), []);
  const sub = useMemo(() => new Animated.Value(0), []);
  const out = useMemo(() => new Animated.Value(1), []);

  useEffect(() => {
    const anim = Animated.sequence([
      Animated.parallel([
        Animated.spring(ring, { toValue: 1, friction: 5, tension: 55, useNativeDriver: true }),
        Animated.timing(spin, {
          toValue: 1,
          duration: 1500,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      Animated.parallel([
        Animated.timing(title, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(bar, {
          toValue: 1,
          duration: 800,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      Animated.timing(sub, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.delay(600),
      Animated.timing(out, { toValue: 0, duration: 400, useNativeDriver: true }),
    ]);
    anim.start(({ finished }) => finished && doneRef.current());
    return () => anim.stop();
  }, [bar, out, ring, spin, sub, title]);

  const rotA = spin.interpolate({ inputRange: [0, 1], outputRange: ['-180deg', '0deg'] });
  const rotB = spin.interpolate({ inputRange: [0, 1], outputRange: ['180deg', '45deg'] });

  return (
    <Pressable style={styles.fill} onPress={() => doneRef.current()}>
      <Animated.View style={[styles.splash, { opacity: out }]}>
        <Animated.View
          style={[
            styles.crest,
            { opacity: ring, transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) }] },
          ]}
        >
          <View style={styles.ring} />
          <Animated.View style={[styles.square, { transform: [{ rotate: rotA }] }]} />
          <Animated.View style={[styles.square, { transform: [{ rotate: rotB }] }]} />
          <View style={styles.gem} />
        </Animated.View>

        <Animated.Text
          style={[
            styles.splashTitle,
            { opacity: title, transform: [{ translateY: title.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] },
          ]}
        >
          THE OLD WORLD
        </Animated.Text>
        <Animated.View style={[styles.goldBar, { transform: [{ scaleX: bar }] }]} />
        <Animated.Text style={[styles.splashSub, { opacity: sub }]}>BATTLE SCORER</Animated.Text>
      </Animated.View>
    </Pressable>
  );
}

function FadeIn({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const v = useMemo(() => new Animated.Value(0), []);
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, [v]);
  return (
    <Animated.View
      style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }]}
    >
      {children}
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Small UI pieces
// ---------------------------------------------------------------------------
function GoldButton({ label, onPress, style }: { label: string; onPress: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable style={[styles.goldBtn, style]} onPress={onPress}>
      <Text style={styles.goldBtnText}>{label}</Text>
    </Pressable>
  );
}

function OutlineButton({
  label,
  onPress,
  style,
  small,
}: {
  label: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
}) {
  return (
    <Pressable style={[styles.outBtn, small && styles.outBtnSmall, style]} onPress={onPress}>
      <Text style={[styles.outBtnText, small && { fontSize: 13 }]}>{label}</Text>
    </Pressable>
  );
}

function Tag({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={6} style={[styles.tag, on && styles.tagOn]}>
      <Text style={[styles.tagText, on && styles.tagTextOn]}>
        {on ? '✓ ' : ''}
        {label}
      </Text>
    </Pressable>
  );
}

function NumInput({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <TextInput
      style={styles.numInput}
      keyboardType="number-pad"
      value={value}
      placeholder="0"
      placeholderTextColor={C.muted}
      onChangeText={(t) => onChange(t.replace(/\D/g, ''))}
    />
  );
}

function SizePicker({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  return (
    <View style={styles.sizeRow}>
      {SIZES.map((label, i) => (
        <Pressable key={label} onPress={() => onChange(i)} style={[styles.sizeChip, value === i && styles.sizeChipOn]}>
          <Text style={[styles.sizeText, value === i && styles.sizeTextOn]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function ScoringPicker({ value, onChange }: { value: Scoring; onChange: (next: Scoring) => void }) {
  return (
    <View style={styles.sizeRow}>
      {SCORING_OPTIONS.map((o) => (
        <Pressable key={o.key} onPress={() => onChange(o.key)} style={[styles.sizeChip, value === o.key && styles.sizeChipOn]}>
          <Text style={[styles.sizeText, value === o.key && styles.sizeTextOn]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function UnitRow({
  unit,
  onChange,
  onDelete,
}: {
  unit: Unit;
  onChange: (patch: Partial<Unit>) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const vp = unitVP(unit);
  const equipment = unit.equipment || [];
  return (
    <View style={[styles.unit, unit.status === 'destroyed' && styles.unitDead]}>
      <View style={styles.unitTop}>
        <Pressable style={{ flex: 1 }} onPress={() => setOpen((o) => !o)}>
          <Text style={styles.unitName}>
            {open ? '▾ ' : '▸ '}
            {unit.name}
          </Text>
          {(unit.isGeneral || unit.isBSB) && (
            <View style={styles.pillRow}>
              {unit.isGeneral && (
                <View style={styles.pill}>
                  <Text style={styles.pillText}>★ General</Text>
                </View>
              )}
              {unit.isBSB && (
                <View style={styles.pill}>
                  <Text style={styles.pillText}>⚑ Battle Standard Bearer</Text>
                </View>
              )}
            </View>
          )}
        </Pressable>
        <TextInput
          style={styles.pointsInput}
          keyboardType="number-pad"
          value={String(unit.points)}
          onChangeText={(t) => onChange({ points: num(t.replace(/\D/g, '')) })}
        />
        <Pressable onPress={onDelete} hitSlop={10}>
          <Text style={styles.delete}>✕</Text>
        </Pressable>
      </View>

      {open && (
        <View style={styles.equip}>
          {equipment.length > 0 ? (
            equipment.map((e, i) => (
              <Text key={i} style={styles.equipItem}>
                • {e}
              </Text>
            ))
          ) : (
            <Text style={styles.equipNone}>No equipment listed for this unit.</Text>
          )}
        </View>
      )}

      <View style={styles.segment}>
        {STATUSES.map((s) => {
          const on = unit.status === s.key;
          return (
            <Pressable
              key={s.key}
              style={[styles.segBtn, on && { backgroundColor: s.color, borderColor: s.color }]}
              onPress={() => onChange({ status: s.key })}
            >
              <Text style={[styles.segText, on && styles.segTextOn]}>{s.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.tagRow}>
        <Tag label="General" on={unit.isGeneral} onPress={() => onChange({ isGeneral: !unit.isGeneral })} />
        <Tag label="BSB" on={unit.isBSB} onPress={() => onChange({ isBSB: !unit.isBSB })} />
        <Tag
          label={`Standard claimed +${STANDARD_VP}`}
          on={unit.standard}
          onPress={() => onChange({ standard: !unit.standard })}
        />
        <Text style={styles.vp}>{vp > 0 ? `+${vp}` : ''}</Text>
      </View>
    </View>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1, paddingRight: 8 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        {!!hint && <Text style={styles.rowHint}>{hint}</Text>}
      </View>
      {children}
    </View>
  );
}

function ScoreCard({
  side,
  game,
  sheet,
  nameOf,
  setManual,
}: {
  side: number;
  game: GameState;
  sheet: ReturnType<typeof buildSheet>;
  nameOf: (i: number) => string;
  setManual: (side: number, patch: Partial<ManualScore>) => void;
}) {
  const man = game.manual[side];
  const enemyName = nameOf(1 - side);
  const a = sheet.auto;
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{nameOf(side)} scored</Text>
      <Text style={styles.cardSub}>
        {a ? `Calculated from ${enemyName}'s army` : `Enter what you took from ${enemyName}`}
      </Text>

      <Row label="Enemy units destroyed (VP)" hint={a ? undefined : 'Total VP of units killed, fled or fleeing'}>
        {a ? <Text style={styles.rowValue}>{sheet.kills}</Text> : <NumInput value={man.kills} onChange={(v) => setManual(side, { kills: v })} />}
      </Row>

      <Row label="Enemy standards claimed" hint={`${STANDARD_VP} VP each`}>
        {a ? (
          <Text style={styles.rowValue}>
            {sheet.standards} → {sheet.standardsVP}
          </Text>
        ) : (
          <View style={styles.inline}>
            <NumInput value={man.standards} onChange={(v) => setManual(side, { standards: v })} />
            <Text style={styles.calc}>→ {sheet.standardsVP}</Text>
          </View>
        )}
      </Row>

      <Row label="Enemy General slain / fled / fleeing" hint={`+${GENERAL_VP} VP`}>
        {a ? (
          <Text style={styles.rowValue}>{sheet.general ? `+${GENERAL_VP}` : '—'}</Text>
        ) : (
          <Tag label="Yes" on={man.general} onPress={() => setManual(side, { general: !man.general })} />
        )}
      </Row>

      <Row label="Enemy Battle Standard Bearer slain / fled / fleeing" hint={`+${BSB_VP} VP`}>
        {a ? (
          <Text style={styles.rowValue}>{sheet.bsb ? `+${BSB_VP}` : '—'}</Text>
        ) : (
          <Tag label="Yes" on={man.bsb} onPress={() => setManual(side, { bsb: !man.bsb })} />
        )}
      </Row>

      <View style={styles.divider} />

      <Row label="Scenario score" hint="Objectives, free entry">
        <NumInput value={man.scenario} onChange={(v) => setManual(side, { scenario: v })} />
      </Row>
      <Row label="Secondary mission score" hint="Free entry">
        <NumInput value={man.secondary} onChange={(v) => setManual(side, { secondary: v })} />
      </Row>

      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Total</Text>
        <Text style={styles.totalNum}>{sheet.total}</Text>
      </View>
    </View>
  );
}

const SIZE_SHORT = ['≤1,000', '1,001–\n1,500', '1,501–\n2,000', '2,001–\n3,000', '3,001+'];

function VPTable({ sizeIdx }: { sizeIdx: number }) {
  return (
    <View>
      <View style={styles.vpRow}>
        <View style={styles.vpLabelCell}>
          <Text style={styles.vpHeadText}>VP difference</Text>
        </View>
        {SIZE_SHORT.map((label, i) => (
          <View key={label} style={[styles.vpCell, sizeIdx === i && styles.vpCellOn]}>
            <Text style={[styles.vpHeadText, sizeIdx === i && styles.vpHeadOn]}>{label}</Text>
          </View>
        ))}
      </View>
      {VP_TABLE.map((row) => (
        <View key={row.label} style={styles.vpRow}>
          <View style={styles.vpLabelCell}>
            <Text style={styles.vpLabel}>{row.label}</Text>
          </View>
          {row.results.map((code, i) => (
            <View key={i} style={[styles.vpCell, sizeIdx === i && styles.vpCellOn]}>
              <Text style={[styles.vpCode, code === 'CV' && styles.vpCodeCV, code === 'D' && styles.vpCodeD]}>{code}</Text>
            </View>
          ))}
        </View>
      ))}
      <Text style={[styles.hint, { marginTop: 10 }]}>
        D = Draw, MV = Marginal Victory, RV = Resounding Victory, CV = Crushing Victory
      </Text>
    </View>
  );
}

function RulesTab({ sizeIdx, scoring }: { sizeIdx: number; scoring: Scoring }) {
  const matched = scoring === 'matched';
  const items = [
    ['Destroyed or fled off the battlefield', "100% of the unit's points cost"],
    ['Fleeing when the game ends', '50% of points cost, rounded up'],
    ['Reduced to 25% of starting Unit Strength or less (or 25% of Wounds where Unit Strength equals Wounds)', '50% of points cost, rounded up'],
    ['Enemy General slain, fled off or fleeing at the end', `+${GENERAL_VP} VP`],
    ['Each enemy standard claimed as a trophy', `+${STANDARD_VP} VP`],
    ['Enemy Battle Standard Bearer slain, fled off or fleeing at the end', `+${BSB_VP} VP`],
    ['Scenario objectives and secondary missions', 'Entered manually in the Scores tab'],
  ];
  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Victory Points</Text>
        {items.map(([a, b]) => (
          <View key={a} style={styles.ruleRow}>
            <Text style={styles.ruleA}>{a}</Text>
            <Text style={styles.ruleB}>{b}</Text>
          </View>
        ))}
      </View>
      <View style={[styles.card, !matched && styles.cardActive]}>
        <Text style={styles.cardTitle}>{`Core rulebook scoring${!matched ? ' (in use)' : ''}`}</Text>
        <Text style={styles.ruleA}>
          Score at least 100 VP more than your opponent to win. Score twice as many VP as your opponent for a crushing
          victory. Any other result is a draw.
        </Text>
      </View>
      <View style={[styles.card, matched && styles.cardActive]}>
        <Text style={styles.cardTitle}>{`Matched play: Victory Points Table${matched ? ' (in use)' : ''}`}</Text>
        <Text style={styles.cardSub}>
          {matched
            ? `The highlighted column is this game: ${SIZES[sizeIdx] ?? SIZES[DEFAULT_SIZE]} pts per side.`
            : 'Used when Matched play scoring is selected.'}
        </Text>
        <VPTable sizeIdx={matched ? sizeIdx : -1} />
      </View>
      <Text style={styles.hint}>Source: Warhammer: The Old World Rulebook.</Text>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
  const [screen, setScreen] = useState<'splash' | 'menu' | 'setup' | 'game' | 'history'>('splash');
  const [mode, setMode] = useState<'two' | 'single'>('two');
  const [draft, setDraft] = useState<DraftEntry[]>(blankDraft());
  const [sizeChoice, setSizeChoice] = useState<number | null>(null); // null = pick from the list
  const [scoringChoice, setScoringChoice] = useState<Scoring>(DEFAULT_SCORING);
  const [game, setGame] = useState<GameState | null>(null);
  const [saved, setSaved] = useState<GameState | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [tab, setTab] = useState<'army' | 'scores' | 'rules'>('army');
  const [armyView, setArmyView] = useState(0);
  const armyScroll = useRef<ScrollView>(null);

  // Load saved game + scoreboard
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        const parsed = safeParseJson<GameState | null>(raw, null, isValidGame);
        if (parsed) setSaved(parsed);
      } catch {
        /* ignore */
      }
      try {
        const rawH = await AsyncStorage.getItem(HISTORY_KEY);
        const parsedHistory = safeParseJson<HistoryEntry[]>(rawH, [], isValidHistory);
        if (parsedHistory.length) setHistory(parsedHistory.slice(0, 200));
      } catch {
        /* ignore */
      }
      setHistoryLoaded(true);
    })();
  }, []);

  // Auto-save the current game on every change
  useEffect(() => {
    if (!game) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(game)).catch(() => {});
  }, [game]);

  // Auto-save the scoreboard
  useEffect(() => {
    if (!historyLoaded) return;
    AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(history)).catch(() => {});
  }, [history, historyLoaded]);

  // Android back button goes to the main menu (progress is already auto-saved)
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen === 'game' || screen === 'setup' || screen === 'history') {
        setScreen('menu');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [screen]);

  const sheets = useMemo(() => (game ? ([buildSheet(game, 0), buildSheet(game, 1)] as const) : null), [game]);

  // Live preview of what the parser found while pasting or typing
  const previews = useMemo(
    () =>
      draft.map((d) => {
        const units = d.text.trim() ? parseList(d.text, 0) : [];
        return {
          count: units.length,
          total: units.reduce((t, u) => t + u.points, 0),
          general: units.find((u) => u.isGeneral)?.name,
          bsb: units.find((u) => u.isBSB)?.name,
        };
      }),
    [draft]
  );

  // Size of game: picked by the player, otherwise suggested from the list total
  const setupPlayers: number[] = mode === 'single' ? [0] : [0, 1];
  const maxListTotal = Math.max(0, ...setupPlayers.map((i) => previews[i].total));
  const suggestedSize = maxListTotal > 0 ? sizeForPoints(maxListTotal) : null;
  const effectiveSize = sizeChoice ?? suggestedSize ?? DEFAULT_SIZE;

  const inProgress = game ?? saved; // a game in memory, or one restored from storage

  const nameOf = (i: number): string => {
    const g: GameState = game || {
      mode,
      players: [{ name: draft[0].name, units: [] }, { name: draft[1].name, units: [] }],
      manual: [newManual(), newManual()],
      recordedId: null,
    };
    const n = g.players[i]?.name ?? '';
    if (n) return n;
    if (g.mode === 'single') return i === 0 ? 'You' : 'Opponent';
    return `Player ${i + 1}`;
  };

  const setDraftField = (i: number, patch: Partial<DraftEntry>) =>
    setDraft((d) =>
      d.map((p, idx) => {
        if (idx !== i) return p;
        const next = { ...p, ...patch };
        if (typeof next.name === 'string') next.name = next.name.slice(0, 80);
        if (typeof next.text === 'string') next.text = next.text.slice(0, MAX_TEXT_LENGTH);
        return next;
      })
    );

  const paste = async (i: number): Promise<void> => {
    try {
      const t = await readClipboard();
      if (!t || !t.trim()) {
        Alert.alert('Clipboard is empty', 'Copy your army list first, then tap Paste.');
        return;
      }
      setDraftField(i, { text: t });
    } catch {
      Alert.alert('Could not read clipboard');
    }
  };

  const openSetup = (m: 'two' | 'single'): void => {
    setMode(m);
    setDraft(blankDraft());
    setSizeChoice(null);
    setScoringChoice(DEFAULT_SCORING);
    setScreen('setup');
  };

  const begin = (): void => {
    const parsed: Unit[][] = [[], []];
    for (const i of setupPlayers) {
      parsed[i] = parseList(draft[i].text, i);
      if (!parsed[i].length) {
        const listOwner = mode === 'single' ? 'your' : draft[i].name.trim() || `Player ${i + 1}`;
        Alert.alert(
          'No units found',
          `Paste or type ${listOwner} army list. Each unit line needs a points value such as 225 pts, 225p or (225).`
        );
        return;
      }
    }
    setGame({
      mode,
      players: [0, 1].map((i) => ({ name: draft[i].name.trim(), units: parsed[i] })) as [PlayerState, PlayerState],
      manual: [newManual(), newManual()],
      recordedId: null,
      sizeIdx: effectiveSize,
      scoring: scoringChoice,
    });
    setArmyView(0);
    setTab('army');
    setScreen('game');
  };

  const start = (): void => {
    if (inProgress) {
      Alert.alert('Replace saved game?', 'Starting a new game overwrites your saved one.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start new', style: 'destructive', onPress: begin },
      ]);
    } else {
      begin();
    }
  };

  const resume = (): void => {
    setGame((g) => g ?? saved ?? null);
    setArmyView(0);
    setTab('army');
    setScreen('game');
  };

  const clearSaved = () =>
    Alert.alert('Delete saved game?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await AsyncStorage.removeItem(STORAGE_KEY);
          } catch {
            /* ignore */
          }
          setSaved(null);
          setGame(null);
        },
      },
    ]);

  // Scoreboard
  // Adds this game's result to the scoreboard (or updates its existing entry).
  const recordResult = (): void => {
    if (!game || !sheets) return;
    const a = sheets[0].total;
    const b = sheets[1].total;
    const sizeIdx = game.sizeIdx ?? DEFAULT_SIZE;
    const scoring = game.scoring ?? DEFAULT_SCORING;
    const o = outcome(a, b, nameOf(0), nameOf(1), sizeIdx, scoring);
    const res: HistoryEntry['result'] = o.code === 'D' ? 'draw' : a > b ? 'win' : 'loss';
    const id = game.recordedId || `${Date.now()}`;
    const entry: HistoryEntry = {
      id,
      date: new Date().toISOString(),
      mode: game.mode,
      names: [nameOf(0), nameOf(1)],
      scores: [a, b],
      result: res,
      title: o.title,
      size: scoring === 'matched' ? SIZES[sizeIdx] : undefined,
      scoring,
    };
    setHistory((h) =>
      h.some((e) => e.id === id) ? h.map((e) => (e.id === id ? { ...entry, date: e.date } : e)) : [entry, ...h]
    );
    setGame((g) => (g ? { ...g, recordedId: id } : g));
  };

  const saveResult = (): void => {
    recordResult();
    Alert.alert('Saved to Scoreboard', 'You can view it from the main menu.');
  };

  // Saves the final scores to the scoreboard, closes the game and returns to the main menu.
  const endGame = (): void => {
    if (!game || !sheets) return;
    Alert.alert('End game?', 'The final scores will be saved to the Scoreboard and this game will be closed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End game',
        onPress: () => {
          recordResult();
          setGame(null);
          setSaved(null);
          setScreen('menu');
          AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
        },
      },
    ]);
  };

  const deleteEntry = (id: string): void =>
    Alert.alert('Delete this result?', '', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => setHistory((h) => h.filter((e) => e.id !== id)) },
    ]);

  const clearHistory = (): void =>
    Alert.alert('Clear the whole scoreboard?', `This deletes all ${history.length} saved result${history.length === 1 ? '' : 's'} and cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => setHistory([]) },
    ]);

  // Game mutations
  const updateUnit = (pi: number, id: string, patch: Partial<Unit>): void =>
    setGame((g) => {
      if (!g) return g;
      return {
        ...g,
        players: g.players.map((p, i) =>
          i === pi ? { ...p, units: p.units.map((u) => (u.id === id ? { ...u, ...patch } : u)) } : p
        ) as [PlayerState, PlayerState],
      };
    });
  const deleteUnit = (pi: number, id: string): void =>
    setGame((g) => {
      if (!g) return g;
      return {
        ...g,
        players: g.players.map((p, i) => (i === pi ? { ...p, units: p.units.filter((u) => u.id !== id) } : p)) as [PlayerState, PlayerState],
      };
    });
  const addUnit = (pi: number): void => {
    uid += 1;
    const unit: Unit = {
      id: `${pi}-${uid}-${Math.random().toString(36).slice(2, 7)}`,
      name: 'New unit',
      points: 0,
      status: 'alive',
      standard: false,
      equipment: [],
      isGeneral: false,
      isBSB: false,
    };
    setGame((g) => {
      if (!g) return g;
      return {
        ...g,
        players: g.players.map((p, i) => (i === pi ? { ...p, units: [...p.units, unit] } : p)) as [PlayerState, PlayerState],
      };
    });
  };
  const setManual = (side: number, patch: Partial<ManualScore>): void =>
    setGame((g) => {
      if (!g) return g;
      return { ...g, manual: g.manual.map((m, i) => (i === side ? { ...m, ...patch } : m)) as [ManualScore, ManualScore] };
    });
  const setGameSize = (sizeIdx: number): void => setGame((g) => (g ? { ...g, sizeIdx } : g));
  const setGameScoring = (scoring: Scoring): void => setGame((g) => (g ? { ...g, scoring } : g));
  const goToArmy = (i: number): void => {
    setArmyView(i);
    armyScroll.current?.scrollTo({ y: 0, animated: false });
  };
  const resetTicks = () =>
    Alert.alert('Reset all unit ticks?', 'Keeps lists and manual scores.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: () =>
          setGame((g) => {
            if (!g) return g;
            return {
              ...g,
              players: g.players.map((p) => ({
                ...p,
                units: p.units.map((u) => ({ ...u, status: 'alive' as UnitStatus, standard: false })),
              })) as [PlayerState, PlayerState],
            };
          }),
      },
    ]);

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------
  if (screen === 'splash') {
    return (
      <View style={styles.safe}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <Splash onDone={() => setScreen('menu')} />
      </View>
    );
  }

  if (screen === 'menu') {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <FadeIn style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.menu}>
            <Text style={styles.menuTitle}>THE OLD WORLD</Text>
            <View style={styles.menuBar} />
            <Text style={styles.menuSub}>BATTLE SCORER</Text>

            {inProgress && (
              <View style={styles.savedCard}>
                <Text style={styles.savedLabel}>Game in progress (auto-saved)</Text>
                <Text style={styles.savedNames}>
                  {(inProgress.players[0].name || (inProgress.mode === 'single' ? 'You' : 'Player 1')) +
                    '  vs  ' +
                    (inProgress.players[1].name || (inProgress.mode === 'single' ? 'Opponent' : 'Player 2'))}
                </Text>
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                  <GoldButton label="Continue" onPress={resume} style={{ flex: 1 }} />
                  <OutlineButton label="Delete" onPress={clearSaved} small />
                </View>
              </View>
            )}

            <GoldButton label="New game: two armies" onPress={() => openSetup('two')} style={{ marginTop: 18 }} />
            <OutlineButton
              label="New game: single army (just me)"
              onPress={() => openSetup('single')}
              style={{ marginTop: 12 }}
            />
            <OutlineButton
              label={`Scoreboard${history.length ? ` (${history.length})` : ''}`}
              onPress={() => setScreen('history')}
              style={{ marginTop: 12 }}
            />
            <Text style={styles.menuHint}>
              Single army mode only needs your list. Enter what you took from your opponent by hand.
            </Text>
          </ScrollView>
        </FadeIn>
      </SafeAreaView>
    );
  }

  if (screen === 'history') {
    const wins = history.filter((e) => e.result === 'win').length;
    const draws = history.filter((e) => e.result === 'draw').length;
    const losses = history.filter((e) => e.result === 'loss').length;
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <ScrollView contentContainerStyle={styles.pad}>
          <View style={styles.titleRow}>
            <Text style={[styles.title, { marginBottom: 0 }]}>Scoreboard</Text>
            {history.length > 0 && (
              <Pressable onPress={clearHistory} hitSlop={10} style={styles.clearBtn}>
                <Text style={styles.clearText}>Clear all</Text>
              </Pressable>
            )}
          </View>

          <View style={styles.recordRow}>
            {([
              ['Wins', wins, C.good],
              ['Draws', draws, C.gold],
              ['Losses', losses, C.danger],
            ] as [string, number, string][]).map(([label, n, col]) => (
              <View key={label} style={styles.recordCell}>
                <Text style={[styles.recordNum, { color: col as string }]}>{n}</Text>
                <Text style={styles.recordLabel}>{label}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.hint}>Record is from the first player side (Player 1, or You in single army mode).</Text>

          {history.length === 0 && (
            <Text style={styles.hint}>
              No results yet. Open a game Scores tab and tap Save result to Scoreboard.
            </Text>
          )}

          {history.map((e) => {
            const col = e.result === 'win' ? C.good : e.result === 'loss' ? C.danger : C.gold;
            const badge = e.result === 'win' ? 'W' : e.result === 'loss' ? 'L' : 'D';
            return (
              <View key={e.id} style={[styles.entry, { borderLeftColor: col }]}>
                <View style={[styles.badge, { backgroundColor: col }]}>
                  <Text style={styles.badgeText}>{badge}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.entryScore}>
                    {e.names[0]} {e.scores[0]} – {e.scores[1]} {e.names[1]}
                  </Text>
                  <Text style={styles.entrySub}>
                    {`${e.title} · ${e.scoring === 'core' ? 'Core rules · ' : e.size ? `${e.size} pts · ` : ''}${new Date(e.date).toLocaleDateString()}`}
                  </Text>
                </View>
                <Pressable onPress={() => deleteEntry(e.id)} hitSlop={10}>
                  <Text style={styles.delete}>✕</Text>
                </Pressable>
              </View>
            );
          })}

          <GoldButton label="Back to menu" onPress={() => setScreen('menu')} style={{ marginTop: 14 }} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === 'setup') {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>{mode === 'single' ? 'Single army' : 'Two armies'}</Text>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Scoring</Text>
            <Text style={styles.cardSub}>
              {scoringChoice === 'matched'
                ? 'The result comes from the Victory Points Table for your game size.'
                : "Win by 100+ VP. Double your opponent's VP is a crushing victory. Anything else is a draw."}
            </Text>
            <ScoringPicker value={scoringChoice} onChange={setScoringChoice} />
          </View>

          {scoringChoice === 'matched' && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Size of game</Text>
              <Text style={styles.cardSub}>Points per side. This decides the victory result.</Text>
              <SizePicker value={effectiveSize} onChange={setSizeChoice} />
              {sizeChoice === null && suggestedSize !== null && (
                <Text style={styles.preview}>Set from your list ({maxListTotal} pts). Tap a size to change it.</Text>
              )}
            </View>
          )}

          {setupPlayers.map((i) => (
            <View key={i} style={styles.card}>
              <Text style={styles.label}>{mode === 'single' ? 'Your name' : `Player ${i + 1} name`}</Text>
              <TextInput
                style={styles.input}
                placeholder={mode === 'single' ? 'You' : `Player ${i + 1}`}
                placeholderTextColor={C.muted}
                value={draft[i].name}
                onChangeText={(t) => setDraftField(i, { name: t })}
              />
              <Text style={styles.label}>{mode === 'single' ? 'Your army list' : 'Army list'}</Text>
              <View style={styles.btnRow}>
                <OutlineButton label="Paste from clipboard" onPress={() => paste(i)} small style={{ flex: 1 }} />
                <OutlineButton label="Clear" onPress={() => setDraftField(i, { text: '' })} small />
              </View>
              <TextInput
                style={[styles.input, styles.listInput]}
                multiline
                textAlignVertical="top"
                placeholder={'Paste or type the list here, one unit per line.\nExample: Greatswords 225p'}
                placeholderTextColor={C.muted}
                value={draft[i].text}
                onChangeText={(t) => setDraftField(i, { text: t })}
              />
              {previews[i].count > 0 && (
                <Text style={styles.preview}>
                  {`${previews[i].count} units found · ${previews[i].total} pts`}
                  {previews[i].general ? `\n★ General: ${previews[i].general}` : ''}
                  {previews[i].bsb ? `\n⚑ Battle Standard Bearer: ${previews[i].bsb}` : ''}
                </Text>
              )}
            </View>
          ))}

          {mode === 'single' && (
            <View style={styles.card}>
              <Text style={styles.label}>Opponent name (optional)</Text>
              <TextInput
                style={styles.input}
                placeholder="Opponent"
                placeholderTextColor={C.muted}
                value={draft[1].name}
                onChangeText={(t) => setDraftField(1, { name: t })}
              />
            </View>
          )}

          <GoldButton label="Start scoring" onPress={start} />
          <OutlineButton label="Back to menu" onPress={() => setScreen('menu')} style={{ marginTop: 10 }} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ----- Game -----
  if (!game || !sheets) return null;
  const single = game.mode === 'single';
  const sizeIdx = game.sizeIdx ?? DEFAULT_SIZE;
  const scoring = game.scoring ?? DEFAULT_SCORING;
  const result = outcome(sheets[0].total, sheets[1].total, nameOf(0), nameOf(1), sizeIdx, scoring);
  const view = single ? 0 : armyView;
  const army = game.players[view].units;
  const hasGeneral = army.some((u) => u.isGeneral);
  const hasBSB = army.some((u) => u.isBSB);
  const armyLabel = (i: number): string =>
    single && !game.players[0].name ? 'Your army' : `${nameOf(i)}'s army`;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <View style={styles.topBar}>
        <Pressable onPress={() => setScreen('menu')} hitSlop={10}>
          <Text style={styles.topMenu}>‹ Menu</Text>
        </Pressable>
        <Text style={styles.topTitle}>THE OLD WORLD</Text>
        <Text style={styles.topSaved}>Auto-saved</Text>
      </View>

      <View style={styles.scoreboard}>
        {[0, 1].map((i) => (
          <View key={i} style={[styles.scoreCell, sheets[i].total > sheets[1 - i].total && styles.scoreLead]}>
            <Text style={styles.scoreName} numberOfLines={1}>
              {nameOf(i)}
            </Text>
            <Text style={styles.scoreNum}>{sheets[i].total}</Text>
          </View>
        ))}
      </View>

      {tab === 'army' && (
        <>
          <View style={styles.tabs}>
            {(single ? [0] : [0, 1]).map((i) => (
              <Pressable key={i} style={[styles.tab, view === i && styles.tabOn]} onPress={() => setArmyView(i)}>
                <Text style={[styles.tabText, view === i && styles.tabTextOn]} numberOfLines={1}>
                  {armyLabel(i)}
                </Text>
              </Pressable>
            ))}
          </View>
          <ScrollView ref={armyScroll} contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
            <Text style={styles.hint}>
              Tap a unit name to see its equipment. Mark what happened to {single ? 'your' : `${nameOf(view)}'s`} units.
              VP go to {nameOf(1 - view)}.
            </Text>
            {(!hasGeneral || !hasBSB) && (
              <Text style={styles.warn}>
                Tip: tap General{!hasBSB ? ' / BSB' : ''} on the right unit so the bonus VP count.
              </Text>
            )}
            {army.map((u) => (
              <UnitRow
                key={u.id}
                unit={u}
                onChange={(patch) => updateUnit(view, u.id, patch)}
                onDelete={() => deleteUnit(view, u.id)}
              />
            ))}
            <View style={styles.btnRow}>
              <OutlineButton label="+ Add unit" onPress={() => addUnit(view)} small style={{ flex: 1 }} />
              <OutlineButton label="Reset ticks" onPress={resetTicks} small style={{ flex: 1 }} />
            </View>
          </ScrollView>

          <View style={styles.actionBar}>
            {!single && view === 0 ? (
              <>
                <OutlineButton label="Skip to scores" onPress={() => setTab('scores')} style={{ flex: 1 }} />
                <GoldButton label={`Next: ${armyLabel(1)} →`} onPress={() => goToArmy(1)} style={{ flex: 2 }} />
              </>
            ) : (
              <GoldButton label="Done · View scores →" onPress={() => setTab('scores')} style={{ flex: 1 }} />
            )}
          </View>
        </>
      )}

      {tab === 'scores' && (
        <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Scoring</Text>
            <ScoringPicker value={scoring} onChange={setGameScoring} />
            {scoring === 'matched' && (
              <>
                <Text style={[styles.label, { marginTop: 12 }]}>Game size (points per side)</Text>
                <SizePicker value={sizeIdx} onChange={setGameSize} />
              </>
            )}
          </View>
          <View style={styles.resultCard}>
            <Text style={styles.resultTitle}>{result.title}</Text>
            <Text style={styles.resultSub}>{result.sub}</Text>
          </View>
          {[0, 1].map((s) => (
            <ScoreCard key={s} side={s} game={game} sheet={sheets[s]} nameOf={nameOf} setManual={setManual} />
          ))}
          <GoldButton label="End game · save scores and return to menu" onPress={endGame} />
          <OutlineButton
            label={history.some((e) => e.id === game.recordedId) ? 'Update Scoreboard entry' : 'Save result and keep playing'}
            onPress={saveResult}
            style={{ marginTop: 10 }}
          />
          <Text style={[styles.hint, { marginTop: 8, textAlign: 'center' }]}>
            End game saves the result to the Scoreboard and closes this game. Saved results appear on the Scoreboard in
            the main menu.
          </Text>
        </ScrollView>
      )}

      {tab === 'rules' && <RulesTab sizeIdx={sizeIdx} scoring={scoring} />}

      <View style={styles.bottomBar}>
        {([
          { key: 'army', label: 'Army' },
          { key: 'scores', label: 'Scores' },
          { key: 'rules', label: 'Rules' },
        ] as { key: 'army' | 'scores' | 'rules'; label: string }[]).map(({ key, label }) => (
          <Pressable key={key} style={styles.bottomBtn} onPress={() => setTab(key)}>
            <Text style={[styles.bottomText, tab === key && styles.bottomTextOn]}>{label}</Text>
            {tab === key && <View style={styles.bottomDot} />}
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  fill: { flex: 1 },
  pad: { padding: 16, paddingBottom: 32 },

  // splash
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },
  crest: { width: 150, height: 150, alignItems: 'center', justifyContent: 'center', marginBottom: 34 },
  ring: {
    position: 'absolute',
    width: 150,
    height: 150,
    borderRadius: 75,
    borderWidth: 3,
    borderColor: C.gold,
    backgroundColor: C.panel,
  },
  square: {
    position: 'absolute',
    width: 82,
    height: 82,
    borderWidth: 3,
    borderColor: C.goldLight,
    backgroundColor: 'rgba(212,175,55,0.12)',
  },
  gem: { width: 24, height: 24, borderRadius: 12, backgroundColor: C.gold },
  splashTitle: { color: C.gold, fontSize: 30, fontWeight: '800', letterSpacing: 7 },
  goldBar: { width: 230, height: 3, backgroundColor: C.gold, marginVertical: 14 },
  splashSub: { color: C.text, fontSize: 14, letterSpacing: 9 },

  // menu
  menu: { flexGrow: 1, padding: 24, justifyContent: 'center' },
  menuTitle: { color: C.gold, fontSize: 30, fontWeight: '800', letterSpacing: 6, textAlign: 'center' },
  menuBar: { alignSelf: 'center', width: 200, height: 3, backgroundColor: C.gold, marginVertical: 12 },
  menuSub: { color: C.text, textAlign: 'center', letterSpacing: 8, fontSize: 13, marginBottom: 26 },
  menuHint: { color: C.muted, textAlign: 'center', marginTop: 16, fontSize: 13 },
  savedCard: { backgroundColor: C.panel, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.goldDark },
  savedLabel: { color: C.gold, fontSize: 12, textTransform: 'uppercase', letterSpacing: 2 },
  savedNames: { color: C.text, fontSize: 17, fontWeight: '700', marginTop: 4 },

  // buttons
  goldBtn: { backgroundColor: C.gold, borderRadius: 10, padding: 15, alignItems: 'center' },
  goldBtnText: { color: C.bg, fontWeight: '800', fontSize: 16 },
  outBtn: { borderWidth: 1.5, borderColor: C.gold, borderRadius: 10, padding: 14, alignItems: 'center' },
  outBtnSmall: { padding: 9 },
  outBtnText: { color: C.gold, fontWeight: '700', fontSize: 15 },
  btnRow: { flexDirection: 'row', gap: 10, marginVertical: 8 },

  // setup / forms
  title: { color: C.gold, fontSize: 26, fontWeight: '800', marginBottom: 12 },
  card: { backgroundColor: C.panel, borderRadius: 12, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: C.line },
  label: { color: C.muted, fontSize: 12, marginTop: 6, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 },
  input: { backgroundColor: C.bg, color: C.text, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, borderWidth: 1, borderColor: C.line },
  listInput: { height: 160 },
  hint: { color: C.muted, fontSize: 13, marginBottom: 8 },
  warn: { color: C.goldLight, fontSize: 13, marginBottom: 10 },

  // game size picker
  sizeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  sizeChip: { borderWidth: 1, borderColor: C.line, borderRadius: 16, paddingHorizontal: 13, paddingVertical: 8 },
  sizeChipOn: { backgroundColor: C.gold, borderColor: C.gold },
  sizeText: { color: C.muted, fontSize: 13, fontWeight: '700' },
  sizeTextOn: { color: C.bg },
  cardActive: { borderColor: C.gold },

  // game chrome
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 10 },
  topTitle: { color: C.gold, fontWeight: '800', letterSpacing: 4, fontSize: 14 },
  topMenu: { color: C.goldLight, fontWeight: '700' },
  scoreboard: { flexDirection: 'row', padding: 12, gap: 10 },
  scoreCell: { flex: 1, backgroundColor: C.panel, borderRadius: 12, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: C.line },
  scoreLead: { borderColor: C.gold, borderWidth: 2 },
  scoreName: { color: C.muted, fontSize: 13 },
  scoreNum: { color: C.goldLight, fontSize: 36, fontWeight: '800' },
  tabs: { flexDirection: 'row', paddingHorizontal: 12, gap: 8 },
  tab: { flex: 1, padding: 10, borderRadius: 8, backgroundColor: C.panel, alignItems: 'center', borderWidth: 1, borderColor: C.line },
  tabOn: { backgroundColor: C.gold, borderColor: C.gold },
  tabText: { color: C.muted, fontWeight: '600' },
  tabTextOn: { color: C.bg },
  actionBar: { flexDirection: 'row', gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.bg },
  bottomBar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.panel },
  bottomBtn: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  bottomText: { color: C.muted, fontWeight: '700', fontSize: 15 },
  bottomTextOn: { color: C.gold },
  bottomDot: { width: 18, height: 3, backgroundColor: C.gold, marginTop: 4, borderRadius: 2 },

  // units
  unit: { backgroundColor: C.panel, borderRadius: 10, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: C.line },
  unitDead: { borderLeftWidth: 4, borderLeftColor: '#B83A2E', opacity: 0.85 },
  unitTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  unitName: { color: C.text, fontSize: 16, fontWeight: '700' },
  pointsInput: { width: 64, backgroundColor: C.bg, color: C.goldLight, textAlign: 'center', borderRadius: 6, paddingVertical: 4, fontSize: 16, borderWidth: 1, borderColor: C.line },
  delete: { color: C.muted, fontSize: 18, paddingHorizontal: 4 },
  segment: { flexDirection: 'row', gap: 6, marginTop: 10 },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: C.line, alignItems: 'center' },
  segText: { color: C.muted, fontSize: 12, fontWeight: '700' },
  segTextOn: { color: '#fff' },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 10 },
  tag: { borderWidth: 1, borderColor: C.line, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 6 },
  tagOn: { backgroundColor: C.gold, borderColor: C.gold },
  tagText: { color: C.muted, fontSize: 12, fontWeight: '700' },
  tagTextOn: { color: C.bg },
  vp: { marginLeft: 'auto', color: C.good, fontWeight: '800', fontSize: 16 },

  // score cards
  resultCard: { backgroundColor: C.panel2, borderRadius: 12, padding: 16, marginBottom: 14, alignItems: 'center', borderWidth: 1.5, borderColor: C.gold },
  resultTitle: { color: C.goldLight, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  resultSub: { color: C.text, marginTop: 4 },
  cardTitle: { color: C.gold, fontSize: 18, fontWeight: '800' },
  cardSub: { color: C.muted, fontSize: 12, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  rowLabel: { color: C.text, fontSize: 14, fontWeight: '600' },
  rowHint: { color: C.muted, fontSize: 11, marginTop: 1 },
  rowValue: { color: C.goldLight, fontSize: 16, fontWeight: '800' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  calc: { color: C.goldLight, fontWeight: '700' },
  numInput: { width: 78, backgroundColor: C.bg, color: C.goldLight, textAlign: 'center', borderRadius: 6, paddingVertical: 6, fontSize: 16, borderWidth: 1, borderColor: C.line },
  divider: { height: 1, backgroundColor: C.line, marginVertical: 6 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 10, borderTopWidth: 1.5, borderTopColor: C.gold },
  totalLabel: { color: C.text, fontSize: 16, fontWeight: '700' },
  totalNum: { color: C.goldLight, fontSize: 30, fontWeight: '800' },

  // name pills / equipment
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  pill: { backgroundColor: C.gold, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 3 },
  pillText: { color: C.bg, fontSize: 11, fontWeight: '800' },
  equip: { marginTop: 10, padding: 10, backgroundColor: C.bg, borderRadius: 8, borderWidth: 1, borderColor: C.line },
  equipItem: { color: C.text, fontSize: 13, marginBottom: 2 },
  equipNone: { color: C.muted, fontSize: 13 },
  preview: { color: C.goldLight, fontSize: 13, marginTop: 8 },
  topSaved: { color: C.muted, fontSize: 12 },

  // scoreboard
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  clearBtn: { borderWidth: 1.5, borderColor: C.danger, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7 },
  clearText: { color: C.danger, fontWeight: '700', fontSize: 13 },
  recordRow: { flexDirection: 'row', gap: 10, marginBottom: 6 },
  recordCell: { flex: 1, backgroundColor: C.panel, borderRadius: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: C.line },
  recordNum: { fontSize: 32, fontWeight: '800' },
  recordLabel: { color: C.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.panel, borderRadius: 10, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: C.line, borderLeftWidth: 4 },
  badge: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: C.bg, fontWeight: '800', fontSize: 16 },
  entryScore: { color: C.text, fontSize: 15, fontWeight: '700' },
  entrySub: { color: C.muted, fontSize: 12, marginTop: 2 },

  // rules
  ruleRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line },
  ruleA: { color: C.text, fontSize: 14 },
  ruleB: { color: C.goldLight, fontSize: 14, fontWeight: '700', marginTop: 2 },

  // victory points table
  vpRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: C.line },
  vpLabelCell: { width: 82, paddingVertical: 8 },
  vpLabel: { color: C.muted, fontSize: 11 },
  vpCell: { flex: 1, alignItems: 'center', paddingVertical: 8 },
  vpCellOn: { backgroundColor: C.panel2 },
  vpHeadText: { color: C.muted, fontSize: 10, textAlign: 'center' },
  vpHeadOn: { color: C.gold, fontWeight: '800' },
  vpCode: { color: C.text, fontSize: 13, fontWeight: '700' },
  vpCodeCV: { color: C.goldLight },
  vpCodeD: { color: C.muted },
});
