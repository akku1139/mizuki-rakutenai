// SPDX-License-Identifier: AGPL-3.0-or-later
import { log, info, warn, error } from './log.ts';

/// Small platform-independent helpers.

/** 改行を優先して切る (コードブロックを考えない素朴な分割) */
const splitPlain = (text: string, len: number): Array<string> => {
  const result: Array<string> = [];
  let rest = text;
  while (true) {
    if (rest.length <= len) {
      result.push(rest);
      break;
    }
    const part = rest.substring(0, len);
    const i = part.lastIndexOf('\n');
    if (i === -1) {
      result.push(part);
      rest = rest.substring(len);
    } else {
      result.push(part.substring(0, i + 1)); // i+1をiにすると改行は消化される
      rest = rest.substring(i + 1);
    }
    if (rest === '') break;
  }
  return result;
};

/** コードブロック 1 つを、フェンスを保ったまま分割する (シンタックスハイライトを保つ) */
const splitCode = (lang: string, body: string, len: number): Array<string> => {
  const open = `\`\`\`${lang}\n`;
  // 本文が改行で終わっているときは、閉じフェンスの前に改行を足さない (元の文面を保つ)
  const closeFence = '```';
  const whole = `${open}${body}${body.endsWith('\n') ? '' : '\n'}${closeFence}`;
  if (whole.length <= len) return [whole];
  const close = '\n```';
  // フェンスで囲み直せないほど小さいときは、素朴に切るしかない
  const room = len - open.length - close.length;
  if (room < 8) return splitPlain(whole, len);

  const trimmed = body.endsWith('\n') ? body.slice(0, -1) : body;
  const parts = splitPlain(trimmed, room)
    .map(p => p.replace(/\n$/, ''))
    .filter(p => p !== '');
  return parts.map(p => `${open}${p}${close}`);
};

/**
 * 長い文字列を Discord の上限に合わせて分割する。
 *
 * コードブロックは壊さない: 収まるならそのまま 1 チャンク、収まらないなら
 * フェンス (` ```lang `) を付け直して分割する (シンタックスハイライトは保たれる)。
 */
export const splitLongString = (text: string, len: number): Array<string> => {
  const pieces: Array<string> = [];
  const fence = /```([^\n]*)\n([\s\S]*?)```/g;
  let last = 0;
  for (const match of text.matchAll(fence)) {
    const start = match.index ?? 0;
    if (start > last) pieces.push(...splitPlain(text.slice(last, start), len));
    pieces.push(...splitCode(match[1] ?? '', match[2] ?? '', len));
    last = start + match[0].length;
  }
  const tail = text.slice(last);
  // 閉じていないフェンスが残っていたら、そこから先はコードとして扱う
  const open = tail.indexOf('```');
  if (open >= 0) {
    if (open > 0) pieces.push(...splitPlain(tail.slice(0, open), len));
    const after = tail.slice(open + 3);
    const newline = after.indexOf('\n');
    const lang = newline < 0 ? after : after.slice(0, newline);
    const body = newline < 0 ? '' : after.slice(newline + 1);
    pieces.push(...splitCode(lang, body, len));
  } else if (tail !== '') {
    pieces.push(...splitPlain(tail, len));
  }

  // ピースを詰め直す (どのピースも len 以下)
  const result: Array<string> = [];
  let current = '';
  for (const piece of pieces) {
    if (piece === '') continue;
    if (current !== '' && current.length + piece.length > len) {
      result.push(current);
      current = '';
    }
    current += piece;
  }
  if (current !== '' || result.length === 0) result.push(current);
  return result;
};

/** Discord / Fluxer のメッセージリンク (チャンネルやサーバーだけのリンクは対象外) */
const MESSAGE_URL = 'https?:\\/\\/(?:canary\\.|ptb\\.)?(?:discord(?:app)?\\.com|fluxer\\.app)\\/channels\\/\\d+\\/\\d+\\/\\d+';
const MESSAGE_LINK = new RegExp(`(?<!<)${MESSAGE_URL}`, 'g');
/** `[この発言](url)` の形。ラベルは残し、URL を `<...>` で囲むだけにする */
const MARKDOWN_MESSAGE_LINK = new RegExp(`\\[([^\\]]*)\\]\\((${MESSAGE_URL})\\)`, 'g');

/**
 * メッセージリンクを `[(1)](<url>)` の形に置き換える (sakana と同じ出典の出し方)。
 *
 * 本文に 88 文字の URL が並ぶと読みにくいので、初出順の番号を振って短く出す。
 * 同じ URL には同じ番号を使う。すでに `[(n)](<url>)` や `[この発言](<url>)` の形になっている
 * リンクはそのまま (URL を `<...>` で囲むだけ)。コードブロックとインラインコードの中も触らない。
 */
export const numberMessageLinks = (text: string): string => {
  const numbers = new Map<string, number>();
  const ref = (url: string): string => {
    const no = numbers.get(url) ?? numbers.size + 1;
    numbers.set(url, no);
    return `[(${no})](<${url}>)`;
  };
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) => (index % 2 === 1 ? part : part
      // `[この発言](url)` はラベルを残して `<>` で囲むだけ (番号に置き換えない)
      .replace(MARKDOWN_MESSAGE_LINK, (_match, label: string, url: string) => `[${label}](<${url}>)`)
      .replace(MESSAGE_LINK, ref)))
    .join('');
};

/**
 * Discord に送る前に URL を `<...>` で囲み、リンクのプレビュー (embed) を出さない。
 *
 * - コードブロックとインラインコードの中は触らない
 * - `[text](url)` は `[text](<url>)` に
 * - 裸の URL は `<url>` に (すでに囲んであるものは二重にしない)
 * - 末尾の句読点は URL に含めない
 */
export const suppressEmbeds = (text: string): string =>
  text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) => (index % 2 === 1 ? part : part
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s>)]+)\)/g, '[$1](<$2>)')
      .replace(/(?<![<(])(https?:\/\/[^\s<>()\]]*[^\s<>()\].,;:!?、。])/g, '<$1>')))
    .join('');

export const isEffectivelyEmpty = (text: string): boolean => {
  // 正規表現の解説:
  // [ \u3000\n\r] : 半角スペース、全角スペース(\u3000)、改行(\n)、復帰(\r)
  // /g : 文字列全体を対象（グローバルマッチ）
  const cleanedText = text.replace(/[ 　\n\r]/g, '');

  return cleanedText.length === 0;
};

export const createFileFromUrl = async (url: string, fileName: string): Promise<File> => {
  // 1. URLからデータを取得
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to fetch ${fileName}: ${response.status} ${response.statusText}`);

  // 2. ResponseをBlob（バイナリデータ）に変換
  const data = await response.blob();

  // 3. Blobのメタデータを元にFileオブジェクトを作成
  // 第二引数にはファイル名、第三引数にはMIMEタイプ（任意）を指定
  // Blob.typeは不明なとき空文字列になるので ?? ではなく || で補う
  const metadata = { type: data.type || 'text/plain' };
  return new File([data], fileName, metadata);
};

export const getFileName = (urlString: string): string => {
  try {
    const url = new URL(urlString);
    // パス（/media/G53TrWRbYAEXaOP.jpg:medium）の最後のセグメントを取得
    const lastSegment = url.pathname.split('/').pop() || '';

    // コロン（:）以降が含まれる場合は、それより前を抽出
    return lastSegment.split(':')[0];
  } catch (e) {
    error("Invalid URL", e);
    return '';
  }
};
