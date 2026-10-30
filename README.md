# ToW Scoring Calculator

React Native app built with Expo and TypeScript.

## Requirements

- Node.js LTS
- npm
- Expo Go on a device for quick testing, or an Android/iOS simulator

## Start the app

```sh
npm install
npm start
```

`npm start` opens the project in Expo Go. If changes still look stale, restart with
a cleared Metro cache:

```sh
npm start -- --clear
```

For a physical device connecting from a remote workspace (such as Codespaces), use
Expo's tunnel:

```sh
npm start -- --tunnel --clear
```

Scan the displayed QR code with Expo Go, or use the Expo CLI shortcuts:

```sh
npm run android
npm run ios
npm run web
```

## Build an Android APK

The `preview` EAS profile creates an installable APK for Android devices. Sign in
to your Expo account, then run:

```sh
npx eas-cli@latest login
npm run build:android:apk
```

EAS builds the APK in the cloud and prints a link to download it when the build
finishes. Open that link on your Android device to install the APK.

The iOS simulator command requires macOS with Xcode. Expo Go can be used to test on a physical iOS device without a Mac.