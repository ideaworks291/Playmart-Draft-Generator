// 出品下書きジェネレーター（index.html）の回帰テスト。
// 過去のセッションで実際に見つかった不具合（CSVの改行問題、重量列の誤解など）を
// 再発防止するために書いたテストをまとめたもの。node標準のassertのみ使用。
//
// 使い方: node tests/generator.test.js
//   もしくは node tests/run-all.js でツール側とまとめて実行
//
// 前提: npm install jsdom が実行済みであること（このディレクトリ、または親ディレクトリで）

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const GENERATOR_PATH = process.env.GENERATOR_PATH || path.join(__dirname, '..', 'index.html');

function loadGenerator(storeKey = 'ishikawa') {
  const html = fs.readFileSync(GENERATOR_PATH, 'utf-8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: `https://example.com/?store=${storeKey}` });
  return dom;
}

// windowに直接値を代入しても、let/constで宣言されたモジュール内変数には反映されない
// （関数宣言はwindowのプロパティになるが、let/constの変数はならない、というJSの仕様）。
// なので状態の確認は必ずDOM経由（生成された画面表示・ダウンロードされる内容）で行う。
function waitReady(dom, ms = 300) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function captureDownloadedCsv(win, doc) {
  let capturedBytes = null;
  win.Blob = function (parts, opts) { capturedBytes = parts[0]; return new (require('buffer').Blob)(parts, opts); };
  win.URL.createObjectURL = () => 'blob://test';
  win.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = function () {};
  win.downloadConfirmedCsv();
  const text = Buffer.from(capturedBytes.buffer || capturedBytes).toString('utf-8');
  return text.split('\r\n').filter(Boolean).map(line => line.split(','));
}

async function testConfirmedListBasics() {
  const dom = loadGenerator();
  const { window } = dom;
  await waitReady(dom);
  const doc = window.document;
  window.alert = () => {};
  window.confirm = () => true;

  doc.getElementById('size-input').value = '140';
  doc.getElementById('mgmt-number-input').value = '3301111';
  doc.getElementById('yahoo-title-input').value = 'テスト商品';
  window.addToConfirmedList();

  assert.strictEqual(doc.getElementById('confirmed-count').textContent, '1', '確定商品リストに1件追加されるはず');

  // 未入力での追加は拒否されるはず
  window.resetAll();
  window.addToConfirmedList();
  assert.strictEqual(doc.getElementById('confirmed-count').textContent, '1', '管理番号未入力の追加は拒否され、件数は増えないはず');

  console.log('  OK: 確定商品リストの基本動作（追加・バリデーション）');
}

async function testCsvHas53ColumnsAndNoEmbeddedNewlines() {
  const dom = loadGenerator();
  const { window } = dom;
  await waitReady(dom);
  const doc = window.document;
  window.alert = () => {};
  window.confirm = () => true;

  doc.getElementById('size-input').value = '140';
  doc.getElementById('mgmt-number-input').value = '3301111';
  doc.getElementById('yahoo-title-input').value = 'テスト商品';
  window.addToConfirmedList();

  const rows = await captureDownloadedCsv(window, doc);
  assert.strictEqual(rows[0].length, 53, 'ヘッダーは53列であるべき');
  assert.strictEqual(rows[1].length, 53, 'データ行も53列であるべき（説明列内の改行で分断されていないこと）');

  console.log('  OK: CSVが53列で、フィールド内改行による行分断が起きていない');
}

async function testShippingPatternValues() {
  const dom = loadGenerator();
  const { window } = dom;
  await waitReady(dom);
  const doc = window.document;
  window.alert = () => {};
  window.confirm = () => true;
  doc.getElementById('size-input').value = '140';

  const cases = [
    { v: 'A', price: '3000', folder: '●売切フォルダ', relist: '3', feature: '0' },
    { v: 'B', price: '1', folder: '★1円出品フォルダ', relist: '3', feature: '0' },
    { v: 'C', price: '1', folder: '★1円出品フォルダ', relist: '3', feature: '20' },
    { v: 'D', price: '1', folder: '■見立10万〜即決フォルダ', relist: '0', feature: '20' },
  ];

  for (let i = 0; i < cases.length; i++) {
    if (i > 0) window.resetAll();
    doc.getElementById('size-input').value = '140';
    const btn = [...doc.querySelectorAll('#pattern-group .btn')].find(b => b.dataset.v === cases[i].v);
    window.selPattern(btn);
    doc.getElementById('mgmt-number-input').value = '400' + i;
    doc.getElementById('yahoo-title-input').value = 'パターンテスト' + i;
    window.addToConfirmedList();
  }

  const rows = await captureDownloadedCsv(window, doc);
  const header = rows[0];
  const priceIdx = header.indexOf('開始価格');
  const folderIdx = header.indexOf('商品保存先フォルダパス');
  const relistIdx = header.indexOf('商品の自動再出品');
  const featureIdx = header.indexOf('注目のオークション');

  cases.forEach((c, i) => {
    const row = rows[i + 1];
    assert.strictEqual(row[priceIdx], c.price, `パターン${c.v}: 開始価格`);
    assert.strictEqual(row[folderIdx], c.folder, `パターン${c.v}: 保存先フォルダ`);
    assert.strictEqual(row[relistIdx], c.relist, `パターン${c.v}: 自動再出品`);
    assert.strictEqual(row[featureIdx], c.feature, `パターン${c.v}: 注目のオークション`);
  });

  console.log('  OK: 出品パターンA〜Dが正しい値の組み合わせで出力される');
}

async function testShippingGroupResolution() {
  const dom = loadGenerator();
  const { window } = dom;
  await waitReady(dom);
  const doc = window.document;
  window.alert = () => {};
  window.confirm = () => true;

  const cases = [
    { carrier: 'ゆうパック', multi: false, expect: '2' },
    { carrier: '佐川急便', multi: false, expect: '3' },
    { carrier: 'ヤマト運輸', multi: false, expect: '4' },
    { carrier: '西濃運輸', multi: false, expect: '' }, // 石川小松店では未対応→空欄
    { carrier: 'ゆうパック', multi: true, expect: '6' }, // 複数個口が最優先
    { carrier: '直接引取のみ', multi: false, expect: '7' },
  ];

  cases.forEach((c, i) => {
    if (i > 0) window.resetAll();
    doc.querySelector(`input[name=carrier][value="${c.carrier}"]`).checked = true;
    if (c.carrier !== 'JITBOX' && c.carrier !== '直接引取のみ') doc.getElementById('size-input').value = '140';
    doc.getElementById('multi-chk').checked = c.multi;
    if (c.multi) {
      doc.getElementById('multi-chk').dispatchEvent(new window.Event('change'));
      const multiInput = doc.getElementById('multi-size-input');
      if (multiInput) multiInput.value = '140,120';
    }
    doc.getElementById('mgmt-number-input').value = '500' + i;
    doc.getElementById('yahoo-title-input').value = '配送グループテスト' + i;
    window.addToConfirmedList();
  });

  const rows = await captureDownloadedCsv(window, doc);
  const idx = rows[0].indexOf('配送グループ');
  cases.forEach((c, i) => {
    assert.strictEqual(rows[i + 1][idx], c.expect, `${c.carrier}${c.multi ? '+複数個口' : ''}: 配送グループ`);
  });

  console.log('  OK: 配送グループの自動判定（キャリア別・複数個口優先・未対応キャリアのフォールバック）');
}

async function testShippingSizeNotWeight() {
  const dom = loadGenerator();
  const { window } = dom;
  await waitReady(dom);
  const doc = window.document;
  window.alert = () => {};
  window.confirm = () => true;

  // 本文用の重量(kg、小数あり)を入れても、CSVの「重量設定」列(実際はサイズクラス)には
  // 一切影響しないことを確認する。過去にこの2つを混同して実装してしまった経緯があるため。
  doc.querySelector('input[name=carrier][value="ゆうパック"]').checked = true;
  doc.getElementById('size-input').value = '140';
  doc.getElementById('weight-chk').checked = true;
  doc.getElementById('weight-chk').dispatchEvent(new window.Event('change'));
  doc.getElementById('weight-input').value = '3.45';
  doc.getElementById('mgmt-number-input').value = '6001';
  doc.getElementById('yahoo-title-input').value = '重量誤解防止テスト';
  window.addToConfirmedList();

  const rows = await captureDownloadedCsv(window, doc);
  const idx = rows[0].indexOf('重量設定');
  assert.strictEqual(rows[1][idx], '140', '重量設定列にはサイズ(140)が入るべきで、本文用重量(3.45)は無関係');

  console.log('  OK: 重量設定列がサイズクラスであり、本文用の重量入力とは独立している');
}

async function testCategoryFixedValue() {
  const dom = loadGenerator();
  const { window } = dom;
  await waitReady(dom);
  const doc = window.document;
  window.alert = () => {};
  window.confirm = () => true;
  doc.getElementById('size-input').value = '140';
  doc.getElementById('mgmt-number-input').value = '7001';
  doc.getElementById('yahoo-title-input').value = 'カテゴリテスト';
  window.addToConfirmedList();

  const rows = await captureDownloadedCsv(window, doc);
  const idx = rows[0].indexOf('カテゴリ');
  assert.strictEqual(rows[1][idx], '23828', 'カテゴリは固定値23828（オーディオ＞その他）であるべき');

  console.log('  OK: カテゴリが固定値23828で出力される');
}

async function testTitleToMgmtAutofill() {
  const dom = loadGenerator();
  const { window } = dom;
  await waitReady(dom);
  const doc = window.document;

  function setTitle(v) {
    const el = doc.getElementById('yahoo-title-input');
    el.value = v;
    el.dispatchEvent(new window.Event('input'));
  }

  setTitle('【C】FOCAL Chorus 826V スピーカーペア フォーカル 2608677');
  assert.strictEqual(doc.getElementById('mgmt-number-input').value, '2608677', '空欄の管理番号にはタイトル末尾の数字が自動転記されるべき');

  window.resetAll();
  doc.getElementById('mgmt-number-input').value = '9999999';
  setTitle('【B】Roland JC-120 ギターアンプ ローランド 1234567');
  assert.strictEqual(doc.getElementById('mgmt-number-input').value, '9999999', '既に入力済みの管理番号は上書きされないべき');

  console.log('  OK: タイトル末尾の数字→管理番号への自動転記（空欄の場合のみ）');
}

async function testConfirmedListLocalStoragePersistence() {
  // 本物のF5リロードを模擬するため、beforeParseフックでlocalStorageに事前に値を
  // 仕込んだ状態で新しくページを開き直す。
  const html = fs.readFileSync(GENERATOR_PATH, 'utf-8');
  function makeDom(seed) {
    return new JSDOM(html, {
      runScripts: 'dangerously', url: 'https://example.com/?store=ishikawa', pretendToBeVisual: true,
      beforeParse(win) { if (seed) for (const [k, v] of Object.entries(seed)) win.localStorage.setItem(k, v); }
    });
  }

  const dom1 = makeDom();
  await waitReady(dom1);
  const doc1 = dom1.window.document;
  dom1.window.alert = () => {};
  dom1.window.confirm = () => true;
  doc1.getElementById('size-input').value = '140';
  doc1.getElementById('mgmt-number-input').value = '8001';
  doc1.getElementById('yahoo-title-input').value = '永続化テスト';
  dom1.window.addToConfirmedList();

  const ls = {};
  for (let i = 0; i < dom1.window.localStorage.length; i++) {
    const k = dom1.window.localStorage.key(i);
    ls[k] = dom1.window.localStorage.getItem(k);
  }

  const dom2 = makeDom(ls);
  await waitReady(dom2);
  const doc2 = dom2.window.document;
  assert.strictEqual(doc2.getElementById('confirmed-count').textContent, '1', 'F5相当の再読み込み後も確定商品リストが復元されるべき');

  console.log('  OK: 確定商品リストのlocalStorage永続化（F5リロード相当）');
}

async function testCarrierSizeDropdownOptions() {
  const dom = loadGenerator();
  const { window } = dom;
  await waitReady(dom);
  const doc = window.document;

  const cases = [
    { carrier: 'ゆうパック', expect: ['', '60','80','100','120','140','160','170'] },
    { carrier: '佐川急便', expect: ['', '60','80','100','140','160','170','180','200','220','240'] }, // 120サイズは存在しない。170〜240はラージサイズ宅配便
    { carrier: 'ヤマト運輸', expect: ['', '60','80','100','120','140','160','200'] }, // 180は存在しない
  ];
  for (const c of cases) {
    doc.querySelector(`input[name=carrier][value="${c.carrier}"]`).checked = true;
    window.onCarrierChange();
    const opts = [...doc.getElementById('size-input').options].map(o => o.value);
    assert.deepStrictEqual(opts, c.expect, `${c.carrier}のサイズ選択肢`);
  }

  // 西濃運輸は従来通り自由入力(select化されない)であるべき
  const seinoLabel = doc.getElementById('seino-carrier-label');
  if (seinoLabel) seinoLabel.classList.remove('hidden');
  doc.querySelector('input[name=carrier][value="西濃運輸"]').checked = true;
  window.onCarrierChange();
  assert.strictEqual(doc.getElementById('size-input').tagName, 'INPUT', '西濃運輸は自由入力のままであるべき');

  console.log('  OK: キャリア別サイズプルダウンが実在するサイズのみで構成される（佐川の120抜け・ヤマトの180抜けを含む）');
}

async function run() {
  console.log('=== generator.test.js (index.html) ===');
  const tests = [
    testConfirmedListBasics,
    testCsvHas53ColumnsAndNoEmbeddedNewlines,
    testShippingPatternValues,
    testShippingGroupResolution,
    testShippingSizeNotWeight,
    testCategoryFixedValue,
    testTitleToMgmtAutofill,
    testConfirmedListLocalStoragePersistence,
    testCarrierSizeDropdownOptions,
  ];
  let failed = 0;
  for (const t of tests) {
    try {
      await t();
    } catch (e) {
      failed++;
      console.error(`  NG: ${t.name}`);
      console.error('     ' + e.message);
    }
  }
  console.log(`--- ${tests.length - failed}/${tests.length} passed ---\n`);
  return failed;
}

if (require.main === module) {
  run().then(failed => process.exit(failed ? 1 : 0));
}

module.exports = { run };
