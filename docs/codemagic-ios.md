# Building and shipping the Doorstep iOS app from Windows, with Codemagic

You built Doorstep on a Windows PC. Apple will not let you build an iOS app on Windows — an iOS app can only be compiled on a Mac, using Apple's Xcode tools. You do not own a Mac, and buying one to ship one app is a poor trade.

Codemagic solves that. This guide takes you from "I have never opened Codemagic" to "the Doorstep app is in TestFlight on my iPhone", in one sitting. You do not need to know Swift or Xcode. Every iOS term is explained the first time it appears.

Read section 2 before you start. It contains the one cost that stops most people.

---

## 1. What Codemagic is doing for you

Codemagic is a build service. When you press a button, it rents a real Mac in a data centre for a few minutes, checks out your `doorstep` code onto it, and runs the build that your Windows PC physically cannot run.

At the end it hands you back a file. For a proper release that file is an `.ipa` — the iOS equivalent of the `.aab` you already upload to Google Play. Codemagic can then send that `.ipa` straight to Apple for you.

You never touch a Mac. You never install Xcode. The whole thing is driven by one file in your repository, `codemagic.yaml`, which is already written and committed. Codemagic reads that file and does what it says.

That file defines exactly three **workflows** (a workflow is one named recipe for a build):

| Workflow | What it does | Needs an Apple account? |
| --- | --- | --- |
| `ios-unsigned` | Compiles the iOS app with no Apple credentials at all. Proves the code builds. | No |
| `ios-release` | Compiles, signs with your Apple identity, uploads to TestFlight. | Yes |
| `android-release` | Builds the Android `.aab`/`.apk`. Optional — you already do this locally. | No |

Run them in that order. `ios-unsigned` first, always.

---

## 2. What it costs, and what you need before you start

### The honest version of the cost

**To put the app on a real iPhone — yours or a tester's — you must join the Apple Developer Program. It costs £79 per year in the UK (US$99 elsewhere), billed annually.** There is no free tier, no trial, and no way around it. TestFlight (Apple's beta-testing service) and the App Store both sit behind that membership.

This is the single most likely thing to stop you, so decide about it now rather than three steps in.

The good news: **`ios-unsigned` needs none of it.** You can connect the repository to Codemagic today, run `ios-unsigned`, and find out whether the iOS app compiles cleanly, without paying Apple a penny. That is genuinely useful. It catches the majority of problems. Do that first, then decide about the £79.

### Codemagic's own cost

Codemagic has a free tier that includes a monthly allowance of macOS build minutes (500 per month at the time of writing) for personal use. A Doorstep build is small — expect roughly 5 to 15 minutes per build, with the first one slower because it downloads dependencies from scratch. You will not run out while setting this up. Check <https://codemagic.io/pricing> for the current numbers.

### Checklist before you start

- A GitHub (or GitLab / Bitbucket) account with the `doorstep` repository pushed to it.
- An Apple ID with two-factor authentication turned on. Apple requires 2FA for developer accounts.
- For `ios-release` only: Apple Developer Program membership, paid and active.
- A Mac is **not** required. An iPhone is only needed at the very end, to install the TestFlight build.

### One caution about enrolling

You will be asked whether you are enrolling as an **individual** or an **organization**. You trade as **TwelveTech Systems Limited**. Enrolling as an organization means the App Store lists TwelveTech Systems Limited as the seller, which looks more legitimate — but Apple requires a D-U-N-S number for the company and verifies it by phone, which can add one to two weeks. Enrolling as an individual is approved in a day or two but lists your personal name as the seller.

You cannot change this later without re-enrolling, so pick deliberately. If you are in a hurry to test, individual is fine; the app is the same either way.

---

## 3. Before you connect: make sure the iOS files are actually committed

Codemagic builds what is **in your Git repository**, not what is on your hard drive. Anything you changed but did not commit and push does not exist as far as the Mac is concerned.

There are iOS files that matter here and that are easy to miss. In particular, the **shared scheme** — a small file that tells Xcode "here is a thing you can build, called App" — lives in a folder that Git tooling often overlooks. Without it, the build fails immediately with `Scheme App not found`.

From the project folder on your PC, in PowerShell:

```powershell
git status
```

If you see any of these listed as modified or untracked, add and push them:

```powershell
git add ios/App/App.xcodeproj/xcshareddata/
git add ios/App/App/Info.plist
git add ios/App/CapApp-SPM/Package.swift
git commit -m "iOS: shared scheme, privacy usage strings, SPM paths"
git push
```

To confirm the scheme really is tracked, this command must print the file path and nothing else:

```powershell
git ls-files ios/App/App.xcodeproj/xcshareddata/xcschemes/
```

If it prints nothing, the scheme is not in the repository and every iOS build will fail. Fix it now.

---

## 4. Connect the repository to Codemagic

1. Go to <https://codemagic.io> and choose **Sign up**.
2. Sign in with the same account that hosts `doorstep` — GitHub, GitLab or Bitbucket. Signing in this way lets Codemagic read your repositories, so you do not have to configure access separately.
3. Approve the permissions when your Git provider asks. Codemagic needs read access to the code and permission to report build status.
4. On the Codemagic dashboard, choose **Add application**.
5. Pick your Git provider, then pick the **doorstep** repository from the list. If it is not listed, choose the option to configure repository access and grant Codemagic access to that specific repository.
6. When asked to select a project type, choose **Other** (or **Ionic/Capacitor** if offered). This matters less than it looks, because of the next step.
7. On the application's settings page, look for the workflow configuration setting and make sure it is set to use **codemagic.yaml**, not the visual Workflow Editor.

Codemagic now reads `codemagic.yaml` from the root of your repository. On the application page you should see the three workflow names — `ios-unsigned`, `ios-release`, `android-release` — in the workflow dropdown.

If you see the visual editor instead of those three names, Codemagic has not found the file. Check that `codemagic.yaml` is committed at the **root** of the repository (not inside a subfolder) and pushed to the branch you are pointing at.

---

## 5. Run `ios-unsigned` first

This is the proof that the pipeline works, and it costs nothing but build minutes.

1. On the Doorstep application page in Codemagic, press **Start new build**.
2. Choose branch **main**.
3. Choose workflow **ios-unsigned**.
4. Press **Start new build**.

Now watch the log. It streams live. You will see, roughly in order:

- the Mac checking out your code,
- `npm ci` installing the Node dependencies,
- `npm run build` producing the web app into `dist/`,
- `npx cap sync ios` copying that web build into the iOS project,
- Xcode resolving Swift packages and compiling,
- a green **Build finished** at the end.

### What success looks like

A green tick, and two files in the **Artifacts** section of the build page: `App-unsigned.zip` (the compiled app) and `App.xcresult` (the full build log — the first place to look if a later build goes red). Neither is a store-ready `.ipa`.

### What it does not mean

**You cannot install this file on an iPhone.** Nothing here is signed. "Signing" means stamping the app with a cryptographic identity issued by Apple that proves who built it; iOS refuses to run any app without one. An unsigned build is a compile check and nothing more.

What it proves is real, though: your Swift packages resolve, your scheme is found, your web assets build and sync, and the Xcode project is not broken. Almost every problem you could hit shows up here, where it is cheap to fix.

If it fails, go to section 10 before doing anything else.

If it succeeds and you have decided to pay Apple, continue. If you have not, stop here — everything below needs the membership.

---

## 6. Create an App Store Connect API key

**App Store Connect** is Apple's equivalent of the Google Play Console: the website where you manage your apps, builds, testers and store listing. It lives at <https://appstoreconnect.apple.com>.

An **App Store Connect API key** is a machine credential. It lets Codemagic talk to Apple on your behalf — fetch signing files, upload builds — without you handing over your Apple ID password, and without a human approving a 2FA prompt in the middle of a build.

Be careful with step 6. There is one step in this process that cannot be repeated.

1. Sign in to <https://appstoreconnect.apple.com> with your Apple ID.
2. Open **Users and Access** from the top navigation.
3. Choose the **Integrations** tab (on some accounts this is still labelled **Keys**).
4. Select **App Store Connect API**, then the **Team Keys** section.
5. Press the **+** button to generate a new key.
   - **Name**: `Codemagic` (any name; it is only a label for you).
   - **Access**: choose **App Manager**. This is the lowest role that can upload builds and manage TestFlight. Do not choose Developer — it cannot upload. Do not choose Admin — it grants more than Codemagic needs.
6. Press **Generate**.
7. **Download the `.p8` file now.** The link says something like *Download API Key*.

   **Apple lets you download this file exactly once.** There is no second chance and no way to recover it. If you lose it, you revoke the key and generate a new one from scratch. Save it somewhere you will still have it in a year — a password manager, or an encrypted folder you back up. Do not commit it to the `doorstep` repository.

You need **three** things from this screen. Copy all three into a safe note before you navigate away:

| What | Where it is | Looks like |
| --- | --- | --- |
| **Issuer ID** | At the top of the Keys page, above the table. One per account. | `57246542-96fe-1a63-e053-0824d011072a` |
| **Key ID** | In the table row for the key you made. | `2X9R4HXF34` |
| **`.p8` file contents** | The file you downloaded. Open it in Notepad. | `-----BEGIN PRIVATE KEY-----` … several lines … `-----END PRIVATE KEY-----` |

When you later paste the `.p8` contents, paste the **whole thing**, including the `BEGIN` and `END` lines and the line breaks between them. A key missing those lines will not work.

---

## 7. Register the app in App Store Connect

Apple will reject an upload for an app it has never heard of. You must create the app record first, with the exact bundle identifier.

A **bundle identifier** is the app's unique, permanent name inside Apple's systems. It is the iOS counterpart of the Android `applicationId`. For Doorstep it is:

```
uk.co.doorstep.app
```

This matches the Android `applicationId` exactly, which is what you want. It cannot be changed after the app is published.

### First, register the identifier with Apple

1. Go to <https://developer.apple.com/account> and open **Certificates, Identifiers & Profiles**.
2. Choose **Identifiers** in the sidebar, then the **+** button.
3. Choose **App IDs**, then **App**, then **Continue**.
4. Fill in:
   - **Description**: `Doorstep`
   - **Bundle ID**: choose **Explicit** and type `uk.co.doorstep.app`
5. Leave the Capabilities list alone. Doorstep does not use push notifications or sign-in-with-Apple yet, so nothing needs enabling.
6. **Continue**, then **Register**.

### Then, create the app record

1. Go to <https://appstoreconnect.apple.com> and open **My Apps** (or **Apps**).
2. Press **+**, then **New App**.
3. Fill in:
   - **Platforms**: iOS
   - **Name**: `Doorstep Giveaways` — this is the public App Store name. Plain `Doorstep` was already registered by another developer: App Store names are unique across the whole store, exactly as Play Store package names are. This field does **not** change the name under the icon on the phone, which comes from `CFBundleDisplayName` in the project and stays `Doorstep`.
   - **Primary Language**: English (U.K.)
   - **Bundle ID**: pick `uk.co.doorstep.app` from the dropdown. If it is not there, the identifier registration above did not complete.
   - **SKU**: an internal reference only, never shown to anyone. `doorstep-ios` is fine.
   - **User Access**: Full Access.
4. Press **Create**.

You do not have to fill in screenshots, descriptions or pricing yet. Those are only needed for an actual App Store submission, not for TestFlight.

---

## 8. Put the credentials into Codemagic

Two things happen here. They are related but separate, and both are needed.

### 8a. Create the Developer Portal integration

This is what lets Codemagic fetch and create signing files automatically, so you never deal with certificates by hand.

Some vocabulary, once:

- A **signing certificate** proves that builds come from you.
- A **provisioning profile** is a permission slip that ties your certificate, your bundle identifier, and a set of allowed devices together.

Historically you generated both by hand on a Mac. With the API key, Codemagic does it for you.

1. In Codemagic, open your account or team settings and find **Integrations**.
2. Find **Developer Portal** (also shown as **App Store Connect**) and choose **Manage keys** / **Connect**.
3. Add a new key:
   - **Name**: `codemagic_app_store_connect` — this must match exactly. `codemagic.yaml` refers to the integration by that name, and a different spelling here is why the build fails with a signing error.
   - **Issuer ID**: paste from section 6.
   - **Key ID**: paste from section 6.
   - **Private key**: upload the `.p8` file, or paste its full contents.
4. Save. Codemagic validates the key immediately. If it reports an error, the most common causes are a truncated `.p8` paste or the Issuer ID and Key ID being swapped.

### 8b. Create the `appstore_credentials` variable group

`codemagic.yaml` expects an environment variable group named exactly:

```
appstore_credentials
```

A **variable group** is a named bundle of secrets that a workflow asks for by name. The `ios-release` workflow will not start without it.

1. In Codemagic, open the Doorstep application, then **Environment variables**.
2. For each variable below: type the name, paste the value, type `appstore_credentials` in the **Group** field, tick **Secure**, and press **Add**.

| Variable name | Value |
| --- | --- |
| `APP_STORE_CONNECT_ISSUER_ID` | The Issuer ID from section 6 |
| `APP_STORE_CONNECT_KEY_IDENTIFIER` | The Key ID from section 6 |
| `APP_STORE_CONNECT_PRIVATE_KEY` | The entire contents of the `.p8` file, `BEGIN`/`END` lines included |
| `CERTIFICATE_PRIVATE_KEY` | An RSA private key Codemagic uses to create and fetch your iOS distribution certificate. You do not have one yet — generate it in Codemagic with **Generate** next to the field, or on any machine with `ssh-keygen -t rsa -b 2048 -m PEM -f cert_key -q -N ""` and paste the contents of `cert_key`. |
| `APP_STORE_APP_ID` | The numeric Apple ID of the app record you created in section 7. Find it in App Store Connect under **App Information → General Information → Apple ID**. It looks like `6501234567`. The build uses it only to ask TestFlight what the last build number was. |

Ticking **Secure** encrypts the value and hides it from build logs. Tick it for all five. The group name must be spelled `appstore_credentials` exactly, with the underscore.

If a build later fails saying a variable is missing or empty, open `codemagic.yaml` and read the `environment:` block of the `ios-release` workflow. The names listed there are the authoritative list, and they win over this table.

---

## 9. Run `ios-release` and find the build in TestFlight

1. In Codemagic, press **Start new build**.
2. Branch **main**, workflow **ios-release**.
3. Press **Start new build** and watch the log.

This build does everything `ios-unsigned` did, and then:

- fetches or creates your signing certificate and provisioning profile using the API key,
- signs the app,
- produces a real `.ipa`,
- uploads it to App Store Connect.

Expect 10 to 20 minutes. The first one is the slowest.

### Finding the build

1. Go to <https://appstoreconnect.apple.com>, open **Doorstep**, then the **TestFlight** tab.
2. Your build appears with the status **Processing**.

   **Be patient here.** Apple re-processes the upload on its own servers. This usually takes 5 to 30 minutes, and the very first build for a brand new app is often slower — an hour is not unusual and does not mean anything is wrong. You will get an email when it finishes.

3. When processing finishes, the status changes. If it says **Missing Compliance**, answer the export-compliance question. Doorstep already declares `ITSAppUsesNonExemptEncryption` as false in `Info.plist`, so this prompt should not appear — if it does, the honest answer for Doorstep is that it uses only standard HTTPS.

### Before you can invite anyone

Apple will not let you distribute a build until you fill in the test details.

1. In **TestFlight**, open **Test Information** in the sidebar.
2. Fill in:
   - **Feedback email**: `syedmuhammadr517@gmail.com`
   - **Privacy Policy URL**: required. Use the Doorstep privacy policy URL you already published for Google Play.
   - **Contact information**: your name and the email above.
3. On the build itself, fill in **What to Test** — a sentence or two telling testers what to look at. This is required and the build stays undistributable without it.
4. Save.

### Installing it on your phone

1. Still in **TestFlight**, choose **Internal Testing**, create a group, and add yourself by the Apple ID email address on your account. Internal testers do not need Apple's beta review, so they get the build within minutes.
2. Install the **TestFlight** app from the App Store on your iPhone.
3. Open the invite email on the phone, or open TestFlight and sign in with the same Apple ID.
4. Install Doorstep and open it.

**External testers** (anyone not on your Apple Developer team, up to 10,000 people) work the same way but require a short Apple beta review of the first build, typically a day. Internal testing first is the faster path.

---

## 10. When a build fails

Work from the **bottom** of the Codemagic log upwards. The last error is usually the real one; everything above it is noise.

| What you see | What it actually means | The fix |
| --- | --- | --- |
| `Scheme App not found` (or `xcodebuild: error: The project named "App" does not contain a scheme named "App"`) | The shared Xcode scheme is not in Git. It is a file Xcode keeps in a folder that gets left out of commits, and without it the Mac does not know what to build. | On your PC: `git add ios/App/App.xcodeproj/xcshareddata/`, commit, push. Verify with `git ls-files ios/App/App.xcodeproj/xcshareddata/xcschemes/` — it must print the `App.xcscheme` path. See section 3. |
| `No matching profiles found` / `No profiles for 'uk.co.doorstep.app' were found` | Apple has no provisioning profile it can build for this bundle identifier. Either the identifier does not match, or the app was never registered. | Check three places agree on `uk.co.doorstep.app`: `PRODUCT_BUNDLE_IDENTIFIER` in `ios/App/App.xcodeproj/project.pbxproj`, `appId` in `capacitor.config.json`, and the app record in App Store Connect. Then confirm you completed section 7 — the identifier registration **and** the app record. |
| Build succeeds, app installs, but opens to a **blank white screen** | The native shell is fine; the web app inside it did not load. The `.ipa` shipped without its web assets, or the assets loaded from paths that do not exist inside a WebView. | The pipeline must run `npm run build` **and** `npx cap sync ios` before Xcode, in that order — `ios/App/App/public/` is generated and is deliberately not in Git. Three settings in the repository also have to stay as they are, because this exact bug bit the Android build: `base: "./"` in `vite.config.js` (a WebView has no site root, so absolute `/assets/...` paths resolve to nothing); the plugin in `vite.config.js` that strips the `crossorigin` attribute (the WebView otherwise blocks the app's own script as cross-origin); and `.env.production` supplying `VITE_API_URL`, since a phone cannot reach a relative `/api`. If any of those are missing, you get a white screen and no error message. |
| `Missing purpose string in Info.plist` / **ITMS-90683** in a rejection email | Apple requires a plain-English sentence explaining why the app wants the camera, photos or location. A missing one is an automatic rejection at upload. | Doorstep's `Info.plist` already contains `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription` and `NSLocationWhenInUseUsageDescription`. If the error names a key, check it is present in `ios/App/App/Info.plist` **and committed**. The error names the exact key that is missing. |
| Upload rejected: *The bundle version must be higher than the previously uploaded version* / duplicate build number | Every upload to Apple needs a build number no other upload has used. Apple never lets you reuse one, even for a build that was deleted. | Raise `CURRENT_PROJECT_VERSION` in `ios/App/App.xcodeproj/project.pbxproj`, commit, push, re-run. See section 11. Note that the version people see (`1.2`) may stay the same; only the build number has to climb. |
| `error: no such module 'Capacitor'` or a Swift Package resolution failure | The local package paths in `ios/App/CapApp-SPM/Package.swift` do not resolve on macOS. Paths written with Windows backslashes are the usual cause. | The paths must use forward slashes: `../../../node_modules/@capacitor/app`. See section 12. |
| Build passes on Codemagic but the app has stale content | The Mac built an older commit. | Confirm you pushed, and that the build you are looking at is the one for your latest commit — the Codemagic build page shows the commit hash and message. |

If the log shows nothing obviously wrong, download the **Xcode build log** from the build's Artifacts section and search it for the word `error:`.

---

## 11. Shipping an update later

The iOS app carries two numbers, and they do the same jobs as the two Android ones:

| iOS setting | Android equivalent | Who sees it | Rule |
| --- | --- | --- | --- |
| `MARKETING_VERSION` | `versionName` | Users, in the App Store | Currently `1.2`. Change when the release is meaningful. |
| `CURRENT_PROJECT_VERSION` | `versionCode` | Nobody, but Apple enforces it | Currently `4`. **Must increase for every single upload.** |

Both live in `ios/App/App.xcodeproj/project.pbxproj`, and each appears **twice** — once for the Debug configuration and once for Release. Change both copies, or you will get a confusing mismatch.

To ship version 1.3, build 5:

1. Open `ios/App/App.xcodeproj/project.pbxproj` in a text editor.
2. Find every `MARKETING_VERSION = 1.2;` and change it to `MARKETING_VERSION = 1.3;` (two occurrences).
3. Find every `CURRENT_PROJECT_VERSION = 4;` and change it to `CURRENT_PROJECT_VERSION = 5;` (two occurrences).
4. Keep Android in step. In `android/app/build.gradle`, set `versionName "1.3"` and `versionCode 5`. Keeping the two platforms on identical numbers makes bug reports far easier to interpret.
5. Commit and push:

   ```powershell
   git add ios/App/App.xcodeproj/project.pbxproj android/app/build.gradle
   git commit -m "Release 1.3 (build 5)"
   git push
   ```

6. In Codemagic, start a new build of **`ios-release`** on **main**.
7. When it lands in TestFlight, update **What to Test** for the new build.

If a build fails after the upload step, the build number may already be consumed at Apple's end. Raise it again rather than retrying the same number.

**In practice you do not have to touch the build number at all.** The `ios-release` workflow asks TestFlight for the highest build number it already holds and uses one higher, so each upload is accepted without you doing anything. The only number you manage by hand is `MARKETING_VERSION` — the `1.2` people see — which you bump when a release is worth calling a new version.

---

## 12. What we changed to make this work

The iOS project Capacitor generated did not build on a Mac as-is. Five changes were needed. Each one is small, and each one was fixing a real failure.

1. **Shared Xcode scheme** (`ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme`) — Xcode creates schemes as personal, per-user files that are not normally committed. A build machine that has never run Xcode interactively has no personal settings, so without a *shared* scheme in the repository the build fails at the first step with `Scheme App not found`.

2. **Privacy usage descriptions** in `ios/App/App/Info.plist` — Apple rejects any upload that can ask for the camera, photo library or location without a sentence explaining why. Doorstep asks for all three, so all three explanations were added. Without them the build compiles and the upload is rejected, which is the most expensive place to find out.

3. **`arm64` device capability** — `UIRequiredDeviceCapabilities` in `Info.plist` listed `armv7`, a 32-bit processor type from iPhone 5-era hardware. Modern iOS does not run 32-bit code at all, and Apple rejects builds that demand it. Changing it to `arm64` states the true requirement.

4. **`ITSAppUsesNonExemptEncryption` set to `false`** — every upload must answer an export-compliance question about encryption. Doorstep uses only standard HTTPS, which is exempt. Declaring this in `Info.plist` answers it once, in the build, instead of stopping every release in TestFlight with a *Missing Compliance* prompt that has to be cleared by hand.

5. **Package.swift path fix** — the Capacitor CLI, run on Windows, wrote the local plugin paths with Windows backslashes (`..\..\..\node_modules\@capacitor\app`). Swift Package Manager on macOS does not treat a backslash as a folder separator, so it could not find the Capacitor plugins and the build failed with unresolved modules. The paths now use forward slashes, which work on both platforms.

---

## Quick reference

| Thing | Value |
| --- | --- |
| Bundle identifier | `uk.co.doorstep.app` |
| App name (on the phone) | Doorstep |
| App name (App Store listing) | Doorstep Giveaways |
| Company | TwelveTech Systems Limited |
| Contact email | syedmuhammadr517@gmail.com |
| Current version / build | `1.2` / `4` |
| Config file | `codemagic.yaml` (repository root) |
| Codemagic variable group | `appstore_credentials` |
| Dependency manager | Swift Package Manager (not CocoaPods) |
| App Store Connect | <https://appstoreconnect.apple.com> |
| Apple Developer portal | <https://developer.apple.com/account> |
