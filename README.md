# Folder Visualizer

Folder Visualizer は、ローカルフォルダの構成・容量・更新時期・整理候補を、ブラウザ内で解析して可視化する読み取り専用の Flask Web アプリです。

Flask は HTML、JavaScript、CSS、同梱版 Plotly.js を配信します。フォルダの列挙、メタデータ解析、検索、比較、レポート生成は利用者のブラウザで実行され、選択したファイルの情報を受け取るアップロード API はありません。解析結果は同じブラウザ・同じオリジンの IndexedDB に保存されます。

大量ファイルを扱う際に画面が固まりにくいよう、解析・比較・SHA-256 計算を Web Worker に分離し、一覧は仮想スクロール、保存データは範囲取得と小さな LRU キャッシュ、グラフはページ単位の遅延生成にしています。

EC2 への本番配信手順は [deploy/README-EC2.md](deploy/README-EC2.md) も参照してください。

## 重要な性質

| 項目 | 実装 |
| --- | --- |
| フォルダ解析 | ブラウザ内の Web Worker |
| 通常解析の対象 | ファイル名、相対パス、サイズ、最終更新日時などのメタデータ |
| サーバへの送信 | ファイル、ファイル一覧、解析結果を送信する API はない |
| 保存先 | ブラウザの IndexedDB v4 |
| ファイル操作 | 削除、移動、名前変更、上書きを行わない |
| 可視化 | ローカル配信の Plotly.js。CDN は使わない |
| 推奨ブラウザ | 最新の Google Chrome / Microsoft Edge |
| 本番構成 | Nginx → Gunicorn → Flask。解析は引き続きブラウザ側 |

## 読み取り専用とプライバシー

### 通常のメタデータ解析

フォルダを選択して行う通常解析では、各 `File` から次の情報を利用します。

- ファイル名
- 選択したルートからの相対パス
- 親フォルダ
- 拡張子と推定カテゴリ
- ファイルサイズ
- 最終更新日時
- パスの深さ

これらから、フォルダ・拡張子・カテゴリ・更新時期の集計、整理候補、重複候補、プロジェクト候補、ヘルススコアを計算します。通常解析では `File.text()`、`File.arrayBuffer()`、`FileReader` などでファイル内容を読みません。

ブラウザのフォルダ選択 API が返す相対パスだけを扱うため、OS 上の絶対パスは取得しません。ファイル名、相対パス、検索条件、IndexedDB の内容、出力レポートは Flask や外部サービスへ送信しません。

### 明示操作時だけ内容を読む3機能

内容を読む機能は次の3つに限定され、いずれも利用者が対象ファイルを明示的に再選択したときだけ動きます。

| 機能 | 読み取り条件と上限 | 用途 |
| --- | --- | --- |
| 重複候補の完全一致確認 | 候補を含むフォルダを再選択。専用 Worker が1ファイルずつ 4 MiB 単位で読む | インクリメンタル SHA-256 による完全一致確認 |
| プロジェクトのマニフェスト詳細確認 | マニフェストを明示選択。1ファイル 2 MiB 以下、最大20件 | `package.json` や `requirements.txt` などから依存関係の概要を抽出 |
| 既存 `.gitignore` との比較 | `.gitignore` を明示選択。1 MiB 以下 | 生成候補との差分確認 |

内容はブラウザ内で処理され、サーバへ送信されません。SHA-256 や抽出した解析結果は IndexedDB に保存される場合がありますが、元ファイルをアップロードする処理はありません。

### 変更しないもの

- ファイルやフォルダを削除しません。
- ファイルやフォルダを移動・改名しません。
- `.gitignore` を直接作成・上書きしません。コピーまたはダウンロードだけです。
- 整理候補の選択は容量シミュレーションだけで、実際の空き容量を変更しません。
- File System Access API の書き込み権限を要求しません。
- 外部 CDN、外部フォント、アクセス解析、広告、決済、ライセンス確認サービスを利用しません。

## ページ一覧

解析結果がない状態で分析ページを直接開いた場合は、メインページへ戻る案内を表示します。自動的にローカルフォルダを開いたり、サーバへ送信したりはしません。

| URL | 主な機能 |
| --- | --- |
| `/` | 未解析時のフォルダ選択・進捗、解析後の縦並び概要・カテゴリ別 Interactive chart、表示切替、検索・絞り込み付き仮想ファイル一覧 |
| `/summary` | ファイル数、フォルダ数、合計容量、代表値、解析・保存時間の概要 |
| `/structure` | フォルダ構造の Treemap / Sunburst、パンくず、深さ・最小サイズ・最大ノード数の調整 |
| `/extensions` | 拡張子別の件数・容量グラフと表 |
| `/age-distribution` | 最終更新時期を8区分に集計し、件数・容量を切り替えて表示 |
| `/large-files` | 容量上位ファイル。最小サイズ、件数、並び順を指定 |
| `/large-directories` | 容量、ファイル数、平均ファイルサイズによる上位フォルダ |
| `/cleanup` | 古い大容量ファイル、0バイト、一時・バックアップ・ログ・ビルド生成物などの整理候補と容量シミュレーター |
| `/duplicates` | 同一サイズ、同名＋同一サイズ、同名＋同一サイズ＋同一更新日時による候補抽出と、明示操作による SHA-256 確認 |
| `/history` | 完了済み解析の履歴一覧、2履歴間の差分、個別削除・全削除 |
| `/saved-searches` | 検索条件の保存、適用、名前変更、並べ替え、削除 |
| `/health-score` | 0～100のスコア、減点理由・件数・しきい値・点数、整理ページへの導線 |
| `/project-analysis` | ファイル名・パスから技術スタックを推定し、明示選択したマニフェストの詳細を確認 |
| `/gitignore` | メタデータと技術スタックから候補を生成し、理由表示、重複除去、コピー、ダウンロード、既存ファイルとの差分確認 |
| `/export` | CSV、JSON、匿名 JSON、HTML レポート、フォルダ構造の各形式を生成 |
| `/compare` | 2つのローカルフォルダ、または2つの解析履歴を比較し、CSV / JSON へ出力 |
| `/settings` | 履歴、一覧、検索、整理しきい値、性能ログ、保存容量、現在解析の削除 |
| `/privacy` | 読み取り範囲、保存先、明示的な内容読み取り、制約の説明 |

配信と監視に使う補助エンドポイントは次のとおりです。

| URL | 内容 |
| --- | --- |
| `/health` | `status` とアプリバージョンを返すヘルスチェック JSON |
| `/assets/<APP_VERSION>/<path>` | 現在のリリースとバージョンが一致する CSS、JavaScript、Worker、Plotly.js の配信 |
| `/static/<path>` | 旧URLとの互換用。再検証が必要な `no-cache` 配信 |
| `/plotly.js` | 旧URLとの互換用。Python パッケージに同梱された Plotly.js の `no-cache` 配信 |

404 と 500 は例外詳細を表示しない専用ページを返します。

## 主な機能

### 解析、検索、一覧

解析結果がないメインページでは、フォルダ選択・解析ボタン・進捗だけを表示します。解析後は自動的に結果画面へ切り替わり、選択フォルダ、合計容量、合計ファイル数を縦に並べた概要と、保存済みカテゴリ集計を使う Interactive chart を表示します。チャートは容量とファイル数を切り替えられ、項目を選ぶと該当ファイル一覧へ移動します。キーボード操作や読み上げ向けの分布表も折りたたみ内に残しています。完了済み結果は再読み込み後も IndexedDB から利用できます。

「ファイル一覧」と「分析メニュー」は表示切替ボタンから開きます。通常表示では全ファイル ID の検索を開始せず、ファイル一覧を初めて開いた時点で遅延実行します。グラフや保存済み検索から絞り込み条件付き URL で戻った場合は、従来どおりファイル一覧を自動表示します。

検索条件は次のとおりです。

- ファイル名または相対パスの部分一致
- 拡張子
- カテゴリ
- 最小・最大サイズ
- 最終更新日の範囲
- 正規表現
- 複数の並び順

条件は URL に反映でき、保存済み検索として名前を付けて再利用できます。同名で保存した場合は一意になるよう接尾辞を付けます。検索条件の変更時はデバウンスし、部分一致検索は IndexedDB カーソルを走査して一致 ID 列を作ります。

### 構造、拡張子、更新時期、ランキング

- 構造ページは最初に Treemap だけを描き、利用者が切り替えたときに Sunburst を生成します。
- 深さ、最小容量、最大ノード数で表示量を抑え、ファイル表示と「その他」への集約を切り替えられます。
- グラフのフォルダ、拡張子、更新時期をクリックすると、該当条件を付けたメイン一覧へ移動できます。
- 拡張子グラフは上位50件までを表示し、全体の集計表も確認できます。
- 大容量ファイルと大容量フォルダは、解析時に保存した上位データを利用します。

Plotly.js を読み込むのは `/`、`/structure`、`/extensions`、`/age-distribution`、`/history`、`/health-score`、`/compare` です。メインページでは有効な解析結果を概要表示するときだけ動的に読み込み、未解析時や条件付きURLでファイル一覧を開く場合は読み込みません。

### 整理候補とヘルススコア

整理候補では、設定したしきい値に基づいて次の候補を組み合わせて抽出できます。

- 古く、かつ大きいファイル
- 0バイトファイル
- 一時ファイル
- バックアップファイル
- ログファイル
- 拡張子なしファイル
- 長いパス、深いパス
- 同名・同サイズのメタデータによる同名ファイル候補
- ビルド生成物やキャッシュ
- 非常に大きいファイル
- 直下ファイルが集中しているフォルダ内のファイル

候補一覧は仮想表示されます。選択した候補について、件数、合計容量、整理前後の想定容量、削減率、カテゴリ・拡張子・フォルダ別内訳を表示しますが、削除処理は実行しません。

ヘルススコアは解析時に保存した統計を優先し、必要な場合だけ保存済みメタデータから再計算します。すべての減点理由を隠さず表示します。ブラウザ API では空フォルダを確実に列挙できないため、空フォルダはスコア対象外です。

### 重複候補と SHA-256

通常解析ではファイル内容を読まず、サイズ、名前、最終更新日時の組み合わせから重複候補を作ります。完全一致を確認したい場合だけ候補を含むフォルダを再選択し、別 Worker で SHA-256 を計算します。

ハッシュ処理は 4 MiB 単位のインクリメンタル処理で、進捗表示とキャンセルに対応します。候補抽出だけでは完全一致を保証しません。また、このページにも削除機能はありません。

### 解析履歴

解析が正常完了すると、現在の解析結果とは別に履歴スナップショットを保存します。既定では新しい5件を残し、設定ページで上限と自動整理を変更できます。

2つの履歴を選ぶと、追加、削除、サイズ変更、更新日時変更、フォルダ・拡張子・カテゴリ別の増減を比較できます。履歴は個別または一括削除できます。

履歴はファイルメタデータを複製するため、解析対象が大きいほど IndexedDB 使用量が増えます。履歴保存だけが容量不足で失敗した場合も、現在の解析結果は完了済みとして利用できます。

### プロジェクト解析

通常解析では、パスと代表的なファイル名から言語、フレームワーク、ビルド環境などの候補を推定し、スコア、確度、根拠を表示します。この段階では内容を読みません。

依存関係などの詳細が必要な場合だけ、マニフェストファイルを利用者が明示選択します。対象は最大20件、各 2 MiB 以下です。

### `.gitignore` 生成支援

解析済みのパス、拡張子、検出したプロジェクト種別、組み込みテンプレートから候補を作ります。候補ごとの理由を確認し、必要な行だけ選択して、重複を除いたプレビューをコピーまたはダウンロードできます。

既存 `.gitignore` との差分を確認する場合だけ、1 MiB 以下のファイルを明示選択します。元の `.gitignore` は変更しません。

### フォルダ比較

次のどちらかを比較できます。

- その場で選択した2つのローカルフォルダ
- IndexedDB に保存した2つの解析履歴

比較処理は Worker へ2,000件単位で渡し、A のみ、B のみ、サイズ変更、更新日時変更、同一の可能性がある項目を分類します。フォルダ、拡張子、カテゴリごとの容量・件数差も集計し、結果一覧を仮想表示します。結果は CSV または JSON でダウンロードできます。

「同一の可能性」はメタデータ比較であり、内容の完全一致を意味しません。

### 出力

出力ページでは次をブラウザ内で生成します。

- 全ファイル CSV
- 現在の URL フィルターを適用した CSV
- 拡張子集計 CSV
- フォルダ集計 CSV
- 更新時期集計 CSV
- 完全解析 JSON
- 匿名統計 JSON
- 単体 HTML レポート
- フォルダ構造の Markdown、プレーンテキスト、JSON、Mermaid

匿名統計 JSON には統計値だけを含め、ファイル名、相対パス、プロジェクトルート名を含めません。フォルダ構造は最大深さ・最大項目数、除外パターン・拡張子、ファイル・容量・日付の含有を調整し、プレビュー、コピー、ダウンロードができます。

CSV は数式として解釈され得る先頭文字を無害化します。HTML やテキスト出力も表示用にエスケープします。大量出力には警告が表示され、生成時はブラウザのメモリと保存先ディスクを使用します。

### 設定

設定ページでは次を変更できます。

- 履歴の保存上限と自動整理
- メイン一覧の表示サイズ
- 検索デバウンス
- 「古い」「大容量」「深い」「長いパス」のしきい値
- Performance API のコンソール出力
- IndexedDB の使用量・利用可能量の確認
- 現在の解析だけの削除

「現在の解析だけを削除」しても、履歴と保存済み検索は残ります。アプリの全保存データを消す場合は、ブラウザのサイトデータ管理を使用します。

## 大量ファイル向けの実装

### 1回走査の解析 Worker

通常解析は 2,000 件単位でメタデータを Worker へ渡します。Worker は1回の走査で次をまとめて処理します。

- 正規化したパス、親フォルダ、拡張子、検索用小文字列の生成
- 合計容量と更新時期8区分
- `Map` を使ったフラットなフォルダ集計
- 拡張子・カテゴリ集計
- 整理候補用のフラグと統計
- ヘルススコア用統計
- プロジェクト候補
- 重複候補
- 容量上位ファイル

容量上位ファイルは上限付きの最小ヒープで保持し、上位候補だけのために全件をソートしません。内部上限は 5,000 件で、各ページは必要な件数だけ表示します。

進捗通知は件数・時間で間引きます。解析ごとのリクエスト ID を照合し、キャンセルや新しい解析の開始時は Worker を終了して、古い結果を反映しません。

### IndexedDB のチャンク保存

解析結果は小さなトランザクションに分けて保存します。`analysisMeta.status` は `processing`、`complete`、`cancelled`、`failed` を取り、`complete` の結果だけを通常表示に利用します。保存途中のデータを完了済みとして扱いません。

新しい解析を開始すると現在解析用のストアを整理しますが、履歴、保存済み検索、設定は個別のストアに残ります。`localStorage` と `sessionStorage` に全ファイルを保存しません。

### 仮想スクロールと範囲キャッシュ

メインのファイル一覧は行高 44 px、前後バッファ 15 行で、原則として DOM 行を100件以下に保ちます。

- 表示範囲に必要な ID とファイルを 500 件単位で IndexedDB から取得
- 直近3チャンクを LRU キャッシュ
- 隣接範囲を先読み
- 同一範囲の重複取得を統合
- `requestAnimationFrame` で描画
- 高速スクロール後に返った古いリクエストを無視
- `ResizeObserver` で小・中・大・全画面の表示行数を再計算
- 全画面は閉じるボタンまたは Escape キーで終了

整理候補、重複候補、比較結果などのクライアント側一覧も、既定 72 px の行高、前後バッファ 12 行、最大100 DOM 行の仮想リストを利用します。

### グラフの遅延生成

Plotly.js は `asset_url("vendor/plotly.min.js")` が生成する、同一オリジンの `/assets/<APP_VERSION>/vendor/plotly.min.js` から読み込みます。メインページでは解析後まで動的読込を遅らせ、構造ページでは Treemap を先に生成し、Sunburst は明示切り替えまで作りません。同一条件の構造データはページ内キャッシュを再利用します。旧 `/plotly.js` は互換用に残しますが、長期キャッシュしません。

### 性能計測

Performance API で、メタデータ準備、Worker 解析、IndexedDB 保存、初期一覧表示、各グラフ、比較などを計測します。主要時間は概要ページに表示し、詳細ログは設定で有効にした場合に開発者コンソールへ出力します。

## IndexedDB v4

データベース名は `folder-visualizer-db`、バージョンは `4` です。16個のオブジェクトストアを使用します。

| オブジェクトストア | 主キー | 内容 |
| --- | --- | --- |
| `analysisMeta` | `id` | 現在解析の状態、ルート名、合計値、代表値、処理時間 |
| `files` | `id` | 現在解析の全ファイルメタデータ |
| `directories` | `path` | フォルダ別の容量・件数 |
| `extensions` | `extension` | 拡張子別の容量・件数 |
| `ageBuckets` | `bucket` | 最終更新時期8区分の集計 |
| `largestFiles` | `id` | 容量上位ファイル |
| `largestDirectories` | `path` | 容量上位フォルダ |
| `duplicateCandidates` | `candidateKey` | メタデータによる重複候補 |
| `duplicateHashes` | `hashKey` | 明示確認した SHA-256 結果 |
| `analysisHistory` | `analysisId` | 履歴スナップショットのメタデータ |
| `historyFiles` | `historyKey` | 履歴ごとのファイルメタデータ |
| `savedSearches` | `id` | 保存済み検索と並び順 |
| `cleanupRules` | `id` | 整理候補ルール |
| `appSettings` | `key` | アプリ設定 |
| `projectDetection` | `detectionKey` | プロジェクト検出結果 |
| `comparisonResults` | `resultKey` | 比較結果 |

以前のスキーマからのアップグレードでは必要なストアとインデックスを作成します。古いデータ世代の解析結果は `requiresReanalysis` として扱われ、新しい集計を得るため再解析が必要です。

IndexedDB はオリジン単位です。ブラウザ、プロファイル、ホスト名、ポート、HTTP / HTTPS のいずれかを変えると、別の保存領域になります。

## 対応ブラウザ

次の Web API を利用します。

- `webkitdirectory` によるフォルダ選択
- IndexedDB
- Web Worker と module Worker
- ES Modules
- `ResizeObserver`
- Blob / File API
- Web Crypto を含む標準 `crypto` API

最新の Google Chrome と Microsoft Edge を推奨します。Safari や Firefox ではフォルダ選択 UI、Worker、保存容量、性能が異なる場合があります。プライベートブラウジングでは IndexedDB の容量や保持期間が通常と異なる場合があります。

本番配信は HTTPS を使用してください。ローカル開発の `http://127.0.0.1` と `http://localhost` はブラウザ上で安全なローカルオリジンとして扱われます。

## ブラウザ API と大量データの制約

### 空フォルダ

`<input type="file" webkitdirectory>` はファイルを返しますが、ファイルを含まないフォルダを確実には返しません。そのため、真に空のフォルダ数は取得できません。

- ヘルススコアは空フォルダを評価対象にしません。
- 構造出力の「空フォルダを含む」は、保存済みメタデータ上に存在するフォルダだけが対象です。
- ファイルが1件もない選択範囲では、ルート情報そのものを取得できない場合があります。

### `File` の再選択

ファイルメタデータと解析履歴は IndexedDB に残りますが、ブラウザの `File` オブジェクトと読み取り許可は再読み込み後まで保持されません。そのため次の操作では対象を再選択します。

- 重複候補の SHA-256 完全一致確認
- プロジェクトマニフェストの内容確認
- 既存 `.gitignore` との比較
- 2つのローカルフォルダのその場比較

### 保存容量

IndexedDB の上限は端末の空き容量、ブラウザ、オリジン、利用モードによって変わります。解析履歴はファイルメタデータを複製するため、現在解析より多くの容量を使用します。

設定ページの保存容量表示を確認し、不要な履歴を削除してください。容量不足時は履歴保存だけに失敗し、現在解析を利用できる場合があります。ブラウザのサイトデータ削除を行うと、解析結果、履歴、設定、保存済み検索も削除されます。

### 処理時間とメモリ

- フォルダ選択直後の `FileList` 列挙とメタデータ準備の一部はブラウザ都合でメインスレッド上に残ります。
- 部分一致・正規表現検索は全件カーソル走査を伴うため、初回検索時間は件数に比例します。
- 2フォルダ比較は両方のメタデータと結果を扱うため、大規模な場合は追加メモリを消費します。
- SHA-256 はチャンク処理ですが、大きな候補ファイルではディスク I/O と計算時間が必要です。
- Treemap / Sunburst はフォルダ集計を使い、最大ノード数で表示量を制限します。
- 数十万件での応答性を考慮した設計ですが、処理件数や完了時間を保証するものではありません。端末性能、ストレージ、ブラウザ、パス構成に依存します。

## ローカルセットアップ

### Windows PowerShell

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
flask --app app run --debug
```

### macOS / Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
flask --app app run --debug
```

ブラウザで `http://127.0.0.1:5000` を開きます。ローカル開発用ランチャーとして `python app.py` も利用できます。

依存パッケージは `requirements.txt` に固定されています。

- Flask 3.1.3
- Gunicorn 23.0.0
- Plotly 6.6.0

Gunicorn は Windows の開発サーバとして使用せず、Linux またはコンテナの本番環境で使用してください。

## 開発

Flask は application factory を使用し、`app.py` が WSGI エントリーポイントです。ブラウザ側は責務別の ES Modules に分かれています。ルート直下の一部 JavaScript は従来パスとの互換用で、実装本体は `static/js/analysis/`、`static/js/storage/`、`static/js/pages/`、`static/js/table/` にあります。

テンプレートの CSS と JavaScript は `asset_url()` で `/assets/<APP_VERSION>/<path>` を生成します。Flask はURLのバージョンが実行中の `APP_VERSION` と完全一致するときだけファイルを返します。ES Modules の相対 import と `new URL(..., import.meta.url)` で起動する module Worker は、入口スクリプトの `/assets/<APP_VERSION>/` prefixを保ったまま依存ファイルを解決します。

本番プロファイルのバージョン付きアセットだけを `public, max-age=31536000, immutable` とします。development と testing のバージョン付きアセット、および全環境の互換URL `/static/...` と `/plotly.js` は `no-cache` です。アセット内容を変更したリリースでは、キャッシュ済みURLの内容を上書きしないよう `APP_VERSION` も必ず変更してください。

主な構成は次のとおりです。

```text
folder-visualizer/
├─ app.py
├─ folder_visualizer/
│  ├─ config.py
│  ├─ routes/
│  ├─ security/
│  └─ utils/
├─ templates/
├─ static/
│  ├─ css/
│  └─ js/
│     ├─ analysis/
│     ├─ common/
│     ├─ pages/
│     ├─ storage/
│     └─ table/
├─ tests/
├─ nginx/
├─ deploy/
├─ Dockerfile
├─ docker-compose.yml
├─ gunicorn.conf.py
├─ requirements.txt
└─ README.md
```

外部サービスへの通信を追加する場合は、このアプリの「ブラウザ内完結」というプライバシー前提が変わるため、UI、CSP、ログ、ドキュメントを同時に見直してください。

## テスト

標準 `unittest` で、Flask の全ページ、ヘルスチェック、404 / 500、セキュリティ・キャッシュヘッダー、アップロード API がないこと、配信設定、IndexedDB スキーマ、Worker、仮想リスト、Plotly.js の限定読込、ネットワーク送信・書き込み API を持たないことなどを確認します。

```powershell
python -m unittest discover -s tests -v
```

ブラウザで変更を確認する場合は、少なくとも次を手動確認してください。

1. 小さいフォルダで解析、キャンセル、再解析ができる。
2. 再読み込み後に現在解析と履歴を復元できる。
3. 高速スクロール、一覧サイズ変更、全画面、Escape 終了が動く。
4. 解析結果なし、0件検索、空に近いフォルダでもエラーにならない。
5. SHA-256、マニフェスト、`.gitignore` は明示選択まで内容を読まない。
6. CSV、JSON、HTML、構造出力をローカルへ保存できる。

## Docker

`Dockerfile` は Python 3.13 slim を基に、非 root の `folderviz` ユーザーで Gunicorn を実行します。Compose はコンテナを読み取り専用にし、Linux capability をすべて削除し、`no-new-privileges` を有効化します。

まず `.env.example` を `.env` にコピーし、十分に長い `SECRET_KEY` と実際の `APP_BASE_URL` を設定します。`.env` は Git にコミットしないでください。

```bash
cp .env.example .env
python3 -c 'import secrets; print(secrets.token_urlsafe(64))'
```

起動と確認は次のとおりです。

```bash
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8000/health
```

Compose は `127.0.0.1:8000` にだけ公開します。インターネットへポート8000を直接公開せず、ホスト Nginx で HTTPS を終端してください。

提供するNginx設定は `/assets/...` をGunicorn / Flaskへプロキシします。Flask側でURLのバージョンを厳密に検証するため、version部分を無視してホスト上の単一ディレクトリへrewriteしないでください。Docker更新時は、コンテナ内のコードと `.env` の `APP_VERSION` を同じリリースにそろえてから再作成します。

コンテナのログファイルは `app-logs` ボリュームへ保存され、`/tmp` は `noexec,nosuid` の一時ファイルシステムです。

## 本番配信

### 推奨構成

```text
利用者ブラウザ
  ├─ フォルダ選択、Worker、IndexedDB、検索、比較、出力
  └─ HTTPS
       ↓
     Nginx
       ├─ TLS、HTTP→HTTPS、バージョン付きアセットのproxy、セキュリティヘッダー
       └─ HTTP / loopback
            ↓
          Gunicorn
            ↓
          Flask
```

サーバは画面と静的アセットを配信し、ローカル解析を実行しません。EC2 の基準構成は Ubuntu 24.04 LTS の小規模 `t3.micro` / `t3.small`、Gunicorn 2 worker × 4 thread です。必要容量はアクセス数と運用監視に合わせて調整してください。

### EC2、DNS、Security Group

本番化の前に Elastic IP と DNS の `A` レコードを設定します。Security Group は次の範囲にします。

- TCP 22: 固定した管理者 IP だけ
- TCP 80: ACME と HTTPS リダイレクト用
- TCP 443: 公開
- TCP 8000: 公開しない

非 Docker 構成の標準インストールは次のとおりです。

```bash
cd /path/to/folder-visualizer
chmod +x deploy/*.sh
sudo APP_DOMAIN=example.com \
  CERTBOT_EMAIL=admin@example.com \
  ./deploy/install.sh
```

インストーラーは `folderviz` ユーザー、タイムスタンプ付き release、`current` シンボリックリンク、仮想環境、systemd、Nginx、Certbot、ログローテーション、`/health` 確認を設定します。環境ファイルは `/etc/folder-visualizer/folder-visualizer.env` に作成されます。

インストール、ALB / ACM、手動証明書設定、障害対応を含む詳細は [EC2 本番配信ガイド](deploy/README-EC2.md) を参照してください。

### Nginx

`nginx/default.conf` は次を行います。

- HTTP から HTTPS へのリダイレクト
- TLS 1.2 / 1.3
- gzip
- `/assets/<APP_VERSION>/...` をFlaskへproxyし、アプリ側でversionの完全一致を検証
- 本番のバージョン付きアセットだけを1年間 `public, immutable` キャッシュ
- development / testing のバージョン付きアセットを `no-cache`
- 互換用 `/static/...` と `/plotly.js` を `no-cache`
- HTML と `/health` の非キャッシュ
- GET / HEAD 以外の拒否
- 1 MiB のリクエスト上限
- Gunicorn へのリバースプロキシ
- URL パス・クエリを記録しない専用アクセスログ形式
- CSP、HSTS、`nosniff`、クリックジャッキング防止などのヘッダー

設定変更時は必ず検証してから再読み込みします。

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### Gunicorn

本番起動コマンドは次のとおりです。

```bash
gunicorn --config gunicorn.conf.py app:app
```

既定値は `127.0.0.1:8000`、2 worker、各4 thread、`gthread`、timeout 30秒、graceful timeout 30秒です。1,000リクエストに0～100の揺らぎを加えて worker を更新し、既定では preload しません。

値は `gunicorn.conf.py` で安全な範囲に制限されます。ブラウザ側解析のファイル数を増やしても、Gunicorn worker を同じ比率で増やす必要はありません。サーバ側の同時アクセス数とメモリを計測して調整してください。

### HTTPS

標準インストーラーは `CERTBOT_EMAIL` が指定されている場合、Let's Encrypt 証明書を取得し、HTTPS 設定へ切り替えます。更新タイマーは次で確認します。

```bash
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
systemctl list-timers certbot.timer
```

証明書更新後は deploy hook が Nginx を検証して再読み込みします。HSTS は、必要なすべてのサブドメインで HTTPS が利用できることを確認してから有効にしてください。

ALB と ACM で TLS を終端する構成も可能です。その場合は ALB と EC2 の Security Group 境界を設定し、信頼したプロキシからだけ `X-Forwarded-*` を受け取ってください。

## 環境変数

`.env.example` が本番用のひな型です。

### Flask とアプリ

| 変数 | 既定値または例 | 用途 |
| --- | --- | --- |
| `FLASK_ENV` | `development` / 本番は `production` | 設定プロファイル |
| `FLASK_DEBUG` | `false` | 開発プロファイルだけで使用。本番は常に無効 |
| `SECRET_KEY` | 開発時はプロセスごとに自動生成 | セッション署名。本番では長い固定ランダム値が必須 |
| `APP_BASE_URL` | `http://127.0.0.1:5000` | 外部公開 URL |
| `APP_VERSION` | `1.1.0` | 画面、`/health`、バージョン付きアセットURLに使うリリースバージョン |
| `LOG_LEVEL` | `INFO` | アプリと Gunicorn のログレベル |
| `APP_LOG_FILE` | 空 | Flask ログ。未指定時は標準エラー出力 |
| `SESSION_COOKIE_SECURE` | 開発 `false`、本番 `true` | HTTPS のみで Cookie を送信 |
| `SESSION_COOKIE_SAMESITE` | `Lax` | `Lax`、`Strict`、`None` |
| `TRUST_PROXY_HEADERS` | 開発 `false`、本番 `true` | 1段の信頼済みリバースプロキシを反映 |
| `FLASK_RUN_HOST` | `127.0.0.1` | `python app.py` のローカル待受 |
| `FLASK_RUN_PORT` | `5000` | `python app.py` のローカルポート |
| `PYTHONDONTWRITEBYTECODE` | `1` | `.pyc` 作成を抑止 |
| `PYTHONUNBUFFERED` | `1` | ログをバッファせず出力 |

### Gunicorn

| 変数 | 既定値 | 用途 |
| --- | ---: | --- |
| `GUNICORN_BIND` | `127.0.0.1:8000` | 待受アドレス |
| `GUNICORN_WORKERS` | `2` | worker プロセス数 |
| `GUNICORN_THREADS` | `4` | worker あたり thread 数 |
| `GUNICORN_TIMEOUT` | `30` | ハードタイムアウト秒 |
| `GUNICORN_GRACEFUL_TIMEOUT` | `30` | graceful restart の待機秒 |
| `GUNICORN_ACCESS_LOG` | `/var/log/folder-visualizer/gunicorn-access.log` | アクセスログ |
| `GUNICORN_ERROR_LOG` | `/var/log/folder-visualizer/gunicorn-error.log` | エラーログ |
| `GUNICORN_MAX_REQUESTS` | `1000` | worker 更新の基準リクエスト数 |
| `GUNICORN_MAX_REQUESTS_JITTER` | `100` | 更新タイミングの揺らぎ |
| `GUNICORN_PRELOAD` | `false` | アプリの事前読込 |
| `GUNICORN_KEEPALIVE` | `5` | keep-alive 秒 |
| `GUNICORN_FORWARDED_ALLOW_IPS` | `127.0.0.1` | forwarded header を許可するプロキシ |

本番では `.env` や `/etc/folder-visualizer/folder-visualizer.env` を公開リポジトリへ置かず、権限を限定してください。EC2 インストーラーが作る環境ファイルは `root:folderviz`、`0640` を維持します。

`APP_VERSION` は単なる表示値ではなく、長期キャッシュの名前空間です。CSS、JavaScript、Worker、Plotly.jsのいずれかを変更するリリースでは必ず値を上げ、同じURLから異なる内容を返さないでください。値には128文字以内の英数字と `. _ + ~ -` だけを使用でき、不正な値ではアプリが起動しません。

## 更新、バックアップ、ロールバック

### 更新

新しいソースでテストした後、EC2 上で実行します。

```bash
cd /path/to/new/folder-visualizer
sudo SOURCE_DIR="$PWD" ./deploy/update.sh
```

更新するソースの `.env.example` に、対象リリースの `APP_VERSION` を設定しておきます。静的アセットを変更したリリースでは必ず新しい値へ上げてください。更新スクリプトはその値を検証し、`SECRET_KEY` など他の設定を保持したまま、環境ファイルの `APP_VERSION` だけを同一ディレクトリ内の一時ファイルとrenameで原子的に更新します。owner/groupとmodeも維持します。

更新スクリプトは現在のreleaseと環境ファイルのversion一致を確認してからバックアップし、新しいタイムスタンプ付きreleaseを作成します。対象versionを環境ファイルへ反映してから `current` を切り替え、サービスを再起動し、`/health` のversionまで一致することを確認します。切り替え・再起動・health確認のいずれかに失敗した場合は、以前の `APP_VERSION` とreleaseリンクをこの順序で復元し、旧releaseを再起動してversion付きhealth checkを再実行します。

Nginx または systemd の構成を変更した場合は、差分を確認して明示的にインストールし、`nginx -t` と `systemd-analyze verify` を通してから再読み込みしてください。

### バックアップ

```bash
sudo /opt/folder-visualizer/current/deploy/backup.sh
```

バックアップは `/var/backups/folder-visualizer` に mode `0600` のアーカイブとして保存され、現在 release の参照、サーバ環境、Nginx、systemd 設定を含みます。

ブラウザの IndexedDB は EC2 に存在しないため、このバックアップには含まれません。必要な解析結果は各利用者が出力ページから保存してください。サーババックアップは暗号化して別アカウントまたは別ストレージへ複製し、独立した保持期間を設定してください。

### ロールバック

利用可能な release を確認します。

```bash
ls -1 /opt/folder-visualizer/releases
```

現在以外の直近 release へ戻す場合は次を実行します。

```bash
sudo /opt/folder-visualizer/current/deploy/rollback.sh
```

特定の release を指定する場合はタイムスタンプを渡します。

```bash
sudo /opt/folder-visualizer/current/deploy/rollback.sh 20260728093000
```

ロールバックスクリプトが対象releaseの `.env.example` から `APP_VERSION` を読み、検証後に環境ファイルへ原子的に反映するため、手動編集は不要です。対象releaseが起動しない、または `/health` のversionが一致しない場合は、開始時の `APP_VERSION` とreleaseリンクを復元し、元のreleaseを再起動して確認します。環境ファイルにある他の値と権限は変更しません。

## ログと監視

```bash
sudo systemctl status folder-visualizer nginx
sudo journalctl -u folder-visualizer --since today
sudo tail -f /var/log/folder-visualizer/application.log
sudo tail -f /var/log/folder-visualizer/gunicorn-error.log
sudo tail -f /var/log/nginx/folder-visualizer_error.log
curl --fail https://example.com/health
```

ログは Nginx、Gunicorn、Flask に分かれ、`deploy/folder-visualizer.logrotate` でローテーションします。提供設定のアクセスログは完全なリクエストターゲットを記録しないため、URL パスとクエリ、検索語、ローカルファイル名、ローカルフォルダ名、referrer、user-agent、IndexedDB 結果、出力内容を記録しません。

アプリケーション例外ログにもクエリ文字列や例外詳細を画面へ出しません。ただし、独自の Nginx、ALB、CDN、WAF、APM を追加する場合は、それらの既定ログが URL やヘッダーを記録しないか別途確認してください。

## セキュリティ

アプリと提供する本番設定には次を含みます。

- Content Security Policy
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- カメラ、位置情報、マイク、決済、USB などを無効化する Permissions Policy
- HTTPS 時の HSTS
- `HttpOnly`、本番 `Secure`、`SameSite` の Cookie
- HTML とヘルスチェックの `no-store`
- 現在versionだけを配信する本番アセットの1年間 immutable キャッシュ
- development / testing と互換アセットURLの `no-cache`
- Flask 本番 debug の強制無効化
- 1 MiB の Flask / Nginx リクエスト上限
- Nginx で GET / HEAD 以外を拒否
- Gunicorn の loopback 待受
- systemd と Docker の非特権実行
- URL・クエリを除いたアクセスログ

本番配信後は次を確認してください。

```bash
curl -I https://example.com/
curl https://example.com/health
sudo nginx -t
sudo systemd-analyze verify /etc/systemd/system/folder-visualizer.service
sudo ss -lntp
```

OS と依存パッケージを定期的に更新し、証明書更新を監視し、`SECRET_KEY` と環境ファイルを保護してください。`FLASK_ENV=production` を維持し、Flask 開発サーバやポート8000をインターネットへ直接公開しないでください。
