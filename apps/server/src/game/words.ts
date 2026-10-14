import { randomInt } from 'node:crypto';
import { charLength, guessKey, hasControlChars, hasMarkup, normalizeDisplay } from './text.js';

export const BUILTIN_WORD_LIST_VERSION = 'builtin-en-v1';

// prettier-ignore
export const BUILTIN_WORDS: readonly string[] = [
  'airplane', 'alarm clock', 'alligator', 'anchor', 'angel', 'ant', 'apple', 'arrow', 'astronaut', 'avocado',
  'backpack', 'bacon', 'balloon', 'banana', 'bandage', 'barn', 'baseball', 'basket', 'bat', 'bathtub',
  'beach', 'bear', 'beard', 'bed', 'bee', 'bell', 'belt', 'bicycle', 'binoculars', 'bird',
  'birthday cake', 'blanket', 'boat', 'bone', 'book', 'boomerang', 'bottle', 'bow tie', 'bowl', 'box',
  'brain', 'bread', 'bridge', 'broom', 'bubble', 'bucket', 'bulldozer', 'bus', 'butterfly', 'cactus',
  'camel', 'camera', 'campfire', 'candle', 'candy', 'cannon', 'car', 'carrot', 'castle', 'cat',
  'caterpillar', 'chair', 'cheese', 'cherry', 'chicken', 'chimney', 'circus', 'clock', 'cloud', 'clown',
  'coconut', 'coffee', 'comb', 'compass', 'computer', 'cookie', 'cow', 'crab', 'crayon', 'crown',
  'cupcake', 'curtain', 'dart', 'desk', 'diamond', 'dice', 'dinosaur', 'dog', 'dolphin', 'donut',
  'door', 'dragon', 'drum', 'duck', 'eagle', 'ear', 'earth', 'egg', 'elephant', 'envelope',
  'eye', 'feather', 'fence', 'fire truck', 'fireworks', 'fish', 'flag', 'flamingo', 'flashlight', 'flower',
  'fork', 'fountain', 'fox', 'frog', 'giraffe', 'glasses', 'globe', 'glove', 'goat', 'grapes',
  'guitar', 'hamburger', 'hammer', 'hand', 'hat', 'headphones', 'heart', 'hedgehog', 'helicopter', 'helmet',
  'hippo', 'hockey', 'honey', 'horse', 'hot dog', 'hourglass', 'house', 'ice cream', 'igloo', 'island',
  'jacket', 'jellyfish', 'jigsaw', 'juice', 'kangaroo', 'key', 'king', 'kite', 'kiwi', 'knife',
  'koala', 'ladder', 'ladybug', 'lamp', 'lemon', 'library', 'light bulb', 'lighthouse', 'lion', 'lipstick',
  'lizard', 'lobster', 'lock', 'magnet', 'mailbox', 'map', 'mask', 'mermaid', 'microphone', 'microscope',
  'monkey', 'moon', 'mountain', 'mouse', 'mushroom', 'necklace', 'nest', 'night', 'nose', 'notebook',
  'octopus', 'onion', 'orange', 'owl', 'paintbrush', 'palm tree', 'panda', 'parachute', 'parrot', 'peacock',
  'pear', 'pencil', 'penguin', 'piano', 'pig', 'pillow', 'pineapple', 'pirate', 'pizza', 'planet',
  'popcorn', 'post office', 'potato', 'pumpkin', 'puzzle', 'pyramid', 'queen', 'rabbit', 'raccoon', 'rain',
  'rainbow', 'rake', 'robot', 'rocket', 'roller coaster', 'rose', 'sailboat', 'sandwich', 'saxophone', 'scarecrow',
  'scarf', 'scissors', 'scooter', 'seahorse', 'shark', 'sheep', 'shell', 'ship', 'shoe', 'shovel',
  'skateboard', 'skeleton', 'skunk', 'sled', 'snail', 'snake', 'snowman', 'soap', 'sock', 'spaceship',
  'spider', 'spoon', 'squirrel', 'stairs', 'star', 'starfish', 'stethoscope', 'strawberry', 'submarine', 'sun',
  'sunflower', 'sunglasses', 'swan', 'sword', 'table', 'taco', 'telescope', 'television', 'tent', 'tiger',
  'toaster', 'toilet', 'tomato', 'tooth', 'toothbrush', 'tornado', 'tractor', 'traffic light', 'train', 'treasure',
  'tree', 'trophy', 'truck', 'trumpet', 'turtle', 'umbrella', 'unicorn', 'vacuum', 'vase', 'violin',
  'volcano', 'waffle', 'wallet', 'watch', 'waterfall', 'watermelon', 'whale', 'wheel', 'windmill', 'witch',
  'wizard', 'wolf', 'worm', 'yo-yo', 'zebra', 'zipper',
];

export const CUSTOM_WORDS_MIN = 10;
export const CUSTOM_WORDS_MAX = 500;
export const WORD_MIN_CHARS = 2;
export const WORD_MAX_CHARS = 32;

// English words and phrases: letters, digits, single spaces, hyphens, apostrophes.
const WORD_PATTERN = /^[a-z0-9]+(?:[ '-][a-z0-9]+)*$/;

export type WordListResult = { ok: true; words: string[] } | { ok: false; message: string };

/** Validates and normalizes a host's custom word list. Duplicates (by guess key) are rejected. */
export function validateCustomWords(input: readonly string[]): WordListResult {
  const words: string[] = [];
  const keys = new Set<string>();
  for (const raw of input) {
    if (hasControlChars(raw) || hasMarkup(raw)) {
      return { ok: false, message: 'Words cannot contain control characters or markup' };
    }
    const word = normalizeDisplay(raw).toLowerCase();
    const length = charLength(word);
    if (length < WORD_MIN_CHARS || length > WORD_MAX_CHARS) {
      return { ok: false, message: `Each word must be ${WORD_MIN_CHARS}-${WORD_MAX_CHARS} characters` };
    }
    if (!WORD_PATTERN.test(word)) {
      return { ok: false, message: 'Use English letters, digits, spaces, hyphens or apostrophes only' };
    }
    const key = guessKey(word);
    if (key.length < WORD_MIN_CHARS) {
      return { ok: false, message: 'Each word needs at least two letters or digits' };
    }
    if (keys.has(key)) return { ok: false, message: `Duplicate word: ${word}` };
    keys.add(key);
    words.push(word);
  }
  if (words.length < CUSTOM_WORDS_MIN || words.length > CUSTOM_WORDS_MAX) {
    return { ok: false, message: `Provide ${CUSTOM_WORDS_MIN}-${CUSTOM_WORDS_MAX} unique words` };
  }
  return { ok: true, words };
}

/**
 * Picks `count` distinct words, preferring ones not yet offered this game.
 * When fewer than `count` unused words remain the pool is recycled, still
 * without duplicates inside one selection.
 */
export function pickWords(pool: readonly string[], used: Set<string>, count = 3): string[] {
  let available = pool.filter((word) => !used.has(word));
  if (available.length < count) {
    used.clear();
    available = [...pool];
  }
  const picked: string[] = [];
  for (let i = 0; i < count && available.length > 0; i++) {
    const index = randomInt(available.length);
    const [word] = available.splice(index, 1);
    picked.push(word!);
    used.add(word!);
  }
  return picked;
}
