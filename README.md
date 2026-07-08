# ShakTranslate 🌍

ShakTranslate is a real-time, two-user AI voice translation application built with React Native (Expo) and Node.js. It leverages Google's Gemini Multimodal API to provide low-latency, bidirectional audio translation between users in different languages.

## 🚀 Features

- **Real-time Voice Translation**: Send audio chunks and receive translated audio instantly.
- **Two-User Sessions**: QR-based pairing allows two users to join a private translation session.
- **Gemini AI Integration**: Uses the latest Gemini 2.0 Flash models for high-quality translation and TTS.
- **Bidirectional Support**: Both users can speak and hear translations in their respective languages.

---

## 🛠️ Project Structure

- `/` (Root): Expo React Native application (Frontend).
- `/backend`: Node.js WebSocket relay and AI processing server.
- `/src`: Frontend source code, components, and services.

---

## ⚙️ Setup & Installation

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v18+ recommended)
- [Expo Go](https://expo.dev/go) app on your mobile device OR an Android/iOS emulator.
- [Google Gemini API Key](https://aistudio.google.com/)

### 2. Backend Setup
1. Navigate to the backend directory:
   ```bash
   cd backend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure environment variables:
   - Create a `.env` file in `/backend` (if not already present).
   - Add your Gemini API key and desired port:
     ```env
     GEMINI_API_KEY=your_api_key_here
     PORT=8080
     ```
4. Start the backend server:
   ```bash
   npm start
   # Or for development with auto-reload:
   npm run dev
   ```

### 3. Frontend Setup
1. Navigate back to the root directory:
   ```bash
   cd ..
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure environment variables:
   - Create a `.env` file in the root directory.
   - Add the Expo public API key:
     ```env
     EXPO_PUBLIC_GEMINI_API_KEY=your_api_key_here
     ```
4. **Important: Update WebSocket URL**
   - Open `src/config.ts`.
   - Update `WS_URL` to match your machine's local IP address if testing on a real device (e.g., `ws://192.168.1.XX:8080`).
5. Start the Expo app:
   ```bash
   npx expo start
   ```

---

## 📱 How to Use

1. **Start the Backend**: Ensure the Node.js server is running and accessible.
2. **Launch the App**: Open the app using Expo Go or an emulator.
3. **Host a Session**:
   - One user taps "Host Session".
   - Select the target languages.
   - A QR code will be generated.
4. **Join a Session**:
   - The second user taps "Join Session".
   - Scan the host's QR code.
5. **Translate**:
   - Press and hold the "Push to Talk" button to speak.
   - The app will stream your audio to the backend, translate it via Gemini, and play it back for the other user.

---

## 📄 License
MIT
