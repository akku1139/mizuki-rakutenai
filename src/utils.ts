// SPDX-License-Identifier: AGPL-3.0-or-later

/// Small platform-independent helpers.

export const splitLongString = (text: string, len: number): Array<string> => {
  const result: Array<string> = [];

  let rest = text;
  while(true) {
    if(rest.length <= len) {
      result.push(rest);
      break;
    }
    const part = rest.substring(0, len);
    const i = part.lastIndexOf('\n');
    if(i === -1) {
      result.push(part);
      rest = rest.substring(len);
    } else {
      result.push(part.substring(0, i+1)); // i+1をiにすると改行は消化される
      rest = rest.substring(i+1);
    }
    if(rest==='') break;
  }

  return result; // 空文字列をfilterしてあげればいい
};

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

  // 2. ResponseをBlob（バイナリデータ）に変換
  const data = await response.blob();

  // 3. Blobのメタデータを元にFileオブジェクトを作成
  // 第二引数にはファイル名、第三引数にはMIMEタイプ（任意）を指定
  const metadata = { type: data.type ?? 'text/plain' };
  return new File([data], fileName, metadata);
};

export const getFileName = (urlString: string): string => {
  try {
    const url = new URL(urlString);
    // パス（/media/G53TrWRbYAEXaOP.jpg:medium）の最後のセグメントを取得
    const lastSegment = url.pathname.split('/').pop() || '';

    // コロン（:）以降が含まれる場合は、それより前を抽出
    return lastSegment.split(':')[0];
  } catch (error) {
    console.error("Invalid URL", error);
    return '';
  }
};
