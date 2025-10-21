// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDZDM4zN88vWv4zXNwj4AgKXZ_S0TrDCL0",
  authDomain: "call-service-67d55.firebaseapp.com",
  projectId: "call-service-67d55",
  storageBucket: "call-service-67d55.firebasestorage.app",
  messagingSenderId: "536614309974",
  appId: "1:536614309974:web:4a9de8c9d856bd1e3eabf7",
  measurementId: "G-P9LK82MYFV"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);