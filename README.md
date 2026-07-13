# カケコミ変換 — 開発者向けREADME

銀行・カード明細CSVをfreee / マネーフォワード / 弥生 / 汎用形式に変換する、サーバーなしの静的Webツール。詳細な要件は [設計書.md](./設計書.md) を参照。

## ファイル構成

```
index.html   全マークアップ（SEOテキスト・FAQ・特商法/ポリシー文を含む）
style.css    全スタイル
app.js       全ロジック（ビルド不要・外部ライブラリなし）
favicon.svg  ファビコン
ogp.png      OGP画像（1200x630）
test/        受け入れ基準検証用のサンプルCSV
```

外部への fetch/XHR、CDN、npm・ビルドツールは一切使用していません。デプロイはファイルをそのままCloudflare Pages（またはGitHub Pages）に置くだけです。

## Pro版アンロックコードの運用

`app.js` 冒頭の `PRO_CODE_HASHES` 配列に、有効なアンロックコードの **SHA-256ハッシュ値** を保持しています。平文のコード自体はリポジトリに含めません。

現在入っているのは実装確認用のデモコードです。**本番公開前に必ず本番用コードへ差し替えてください。**

- デモコード: `KAKEKOMI-DEMO-0000`
- デモコードのハッシュ: `320bc2c293ab3d7c42123de9c329e8c742535401c07018415c35eb30d52f630c`

### 新しいコードのハッシュを生成する（PowerShell）

```powershell
$code = "ここに新しいコードを入力"
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($code)
$hash = $sha256.ComputeHash($bytes)
($hash | ForEach-Object { $_.ToString("x2") }) -join ""
```

出力されたhex文字列を `app.js` の `PRO_CODE_HASHES` 配列に追加します。

### コードのローテーション手順（月1メンテ、コード流出時）

1. 上記コマンドで新しいコードのハッシュを生成する
2. `PRO_CODE_HASHES` に新しいハッシュを追加する（既存のハッシュは**削除しない**。既購入者のPro状態を壊さないため、最低6ヶ月は残す）
3. BOOTHの商品説明・配布ファイルを新しいコードに差し替える
4. 6ヶ月以上経過した旧ハッシュは `PRO_CODE_HASHES` から削除してよい
5. 変更をpushする（Cloudflare Pagesが自動デプロイ）

## 出力形式テンプレートの場所

`app.js` の `OUTPUT_FORMATS` 定数（`freee` / `mf` / `yayoi` / `generic`）に、各社の列構成を定義しています。会計ソフト側の仕様変更が確認された場合は、この定数のみを修正すれば追随できます。

### 最新仕様の確認記録

- 確認日: 2026-07-08（Web検索による確認。契約者向け管理画面の実物確認ではないため、変更があれば都度検証すること）
- freee: 「取引日／出金額・決済額／利用内容・摘要」の3点で明細アップロード可能。取込時にfreee側でCSVの列とfreeeの項目を対応づけるマッピング画面があるため、列名が完全一致していなくても取込可能。参照: [freeeヘルプセンター](https://support.freee.co.jp/hc/ja/articles/202847320)
- マネーフォワード クラウド: CSV取込の入力必須項目は「日付」「金額」の2つ。サンプルフォーマットは「日付」「内容」「出金額」「入金額」の構成。参照: [マネーフォワード クラウド確定申告サポート](https://biz.moneyforward.com/support/tax-return/guide/import/im01.html)
- 弥生（スマート取引取込）: CSVファイル取込の基本項目は「日付」「入金」「出金」、「摘要」は任意項目。列の対応づけは弥生側の画面で設定でき、一度設定すれば次回以降自動取込できる。対応文字コードはShift-JISが基本（TextEncoderがShift-JISエンコードに対応しないため、本ツールはUTF-8 BOM付きで出力し、取込エラー時の確認を促す注記を画面に表示している）。参照: [弥生サポート情報](https://support.yayoi-kk.co.jp/faq_Subcontents.html?page_id=23508)、[弥生サポート情報（CSVファイル取込）](https://support.yayoi-kk.co.jp/subcontents.html?page_id=1296)
- 汎用形式: 本ツール独自の定義（日付・摘要・金額）のため確認対象外

3社とも「取込時に列位置をユーザー側でマッピングする」機能を持つため、列名が完全一致しなくても実用上は取り込める設計になっている。

## 月1回の保守チェックリスト

1. Search Consoleでクエリを確認し、index.html のSEOテキストを補正する
2. 会計ソフト側のインポート仕様に変更がないか確認する（変更があれば `OUTPUT_FORMATS` を修正）
3. Proコードの流出報告があればローテーションする
4. 変更をpushする

## テストフィクスチャ

`test/` 配下に3本のサンプルCSVを用意しています。設計書§8.3の受け入れ基準を手動で確認する際に使用してください。

- `sample_bank_sjis.csv`: Shift_JISエンコード・半角カナ摘要を含む銀行風の明細
- `sample_card_utf8.csv`: UTF-8(BOM付き)のカード明細風データ
- `sample_edge_cases.csv`: クォート内カンマ・全角数字・和暦日付・パース不能な日付など、エッジケース詰め合わせ
