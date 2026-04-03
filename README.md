# Folder Visualizer

ローカル PC 上のフォルダ構造を、ブラウザ内だけで解析して可視化する Flask アプリです。Flask は画面配信用に使い、フォルダ解析・集計・描画はすべてブラウザ側 JavaScript で行います。

## 機能

- ブラウザでフォルダを直接選択
- 選択フォルダの再帰的なメタデータ解析
- 総容量、総ファイル数、総フォルダ数の集計
- 拡張子別の件数と容量集計
- Treemap / Sunburst によるフォルダ階層可視化
- 大きいファイル一覧
- 大きいフォルダ一覧
- 拡張子、最小サイズ、ファイル名によるファイル絞り込み
- Plotly.js をローカル配信し、外部 CDN を使わない構成
- ファイル内容は読まず、サイズや更新日時などのメタデータのみ利用

## ディレクトリ構成

```text
folder-visualizer/
├─ app.py
├─ templates/
│  ├─ base.html
│  └─ index.html
├─ static/
│  ├─ css/
│  │  └─ style.css
│  └─ js/
│     └─ main.js
├─ requirements.txt
└─ README.md
```

## セットアップ

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
flask --app app run --debug
```

ブラウザで `http://127.0.0.1:5000` を開いて利用します。

## 使い方

1. 画面上部のファイル選択欄から解析したいフォルダを選びます。
2. `選択フォルダを解析` を押します。
3. ブラウザ内で集計が実行され、Treemap / Sunburst、拡張子別グラフ、ランキング、フィルタ付き一覧が表示されます。

## 仕組み

- フォルダ選択はブラウザの `input type="file"` と `webkitdirectory` を使います。
- 取得できるのは `webkitRelativePath`、ファイルサイズ、更新日時などのメタデータです。
- 絶対パスや未選択フォルダの情報はブラウザから取得できません。
- サーバに送る API は持たず、解析結果はブラウザメモリ上だけに存在します。

## ルート

- `GET /`
  トップ画面を返します。
- `GET /health`
  `{"status": "ok"}` を返します。
- `GET /plotly.js`
  ローカルにインストールされた Plotly.js バンドルを返します。

## 制約

- ブラウザ API の都合で、表示されるパスは選択フォルダ起点の相対パスです。
- アクセス権限エラーや OS 保護領域の詳細は、ブラウザ側では通常取得できません。
- 非常に大量のファイルを含むフォルダでは、解析完了まで時間がかかります。

