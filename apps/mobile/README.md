# @meshimap/mobile

MeshiMap のモバイルアプリ（Expo / React Native / NativeWind）。
プロジェクト全体の説明は[ルート README](../../README.md) を参照してください。

## 起動

Expo Dev Client を使うため **Expo Go では動きません**。実機またはシミュレータが必要です。

```bash
nvm use                # Node 22.23.2
npm install            # ルートで実行する

npm run mobile         # 開発サーバ（ルートから実行する。以下も同じ）
npm run mobile:ios     # iOS シミュレータ
npm run mobile:android # Android エミュレータ
```

ネイティブプロジェクト（`ios/` / `android/`）は生成物なのでコミットしていません。
実機ビルドが要るときは `npm run prebuild -w @meshimap/mobile` で生成します（`.gitignore` の `/ios` `/android`）。

## ディレクトリ

| パス              | 責務                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `src/app/`        | 画面。expo-router のファイルベースルーティング。組み立てのみ行う |
| `src/components/` | `ui/` にドメインを知らないプリミティブ 8 種（実装済み）          |
| `src/constants/`  | デザイントークン（`theme.ts` / `fonts.ts`）                      |
| `src/hooks/`      | 画面から切り出した状態ロジック                                   |
| `src/lib/`        | ロガーなどの薄いユーティリティ                                   |

判断ロジック（営業時間・予約枠・評価・地理計算）はこの階層に置かず、
`packages/core` と `packages/geo` に置いて Workers 側と共有しています。

## スタイル

NativeWind（Tailwind）を使います。色・余白・角丸・フォントは `tailwind.config.js` の
トークンに集約してあるので、`#RRGGBB` や `px` の直書きはしません。

```tsx
<View className="gap-sm rounded-card bg-neutral-50 p-md">
```

`ActivityIndicator` の `color` のように className が効かない props だけ、
`src/constants/theme.ts` の定数から JS で渡します。

## テスト

```bash
npm test          -w @meshimap/mobile   # Jest + jest-expo + React Native Testing Library
npm run test:coverage -w @meshimap/mobile
npm run typecheck -w @meshimap/mobile
npm run lint      -w @meshimap/mobile
```

テストは実装の詳細ではなく、ユーザーから見える振る舞い（表示されるテキスト、
アクセシビリティロール、押したときに何が起きるか）を対象にします。
