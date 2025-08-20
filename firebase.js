// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCimygGJd3U7uAijoD1bQePBDlm6Luxpl8",
  authDomain: "callservice-69520.firebaseapp.com",
  projectId: "callservice-69520",
  storageBucket: "callservice-69520.firebasestorage.app",
  messagingSenderId: "1098179653505",
  appId: "1:1098179653505:web:b47bdabc03d53869680280",
  measurementId: "G-N47LS2Q583"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);