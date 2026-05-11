import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyC6d2ihQZBinYOh5NjYmC4CqlvH9Dh6Yo8",
  authDomain: "electratechlivequiz.firebaseapp.com",
  projectId: "electratechlivequiz",
  storageBucket: "electratechlivequiz.firebasestorage.app",
  messagingSenderId: "268767149449",
  appId: "1:268767149449:web:5b93fcf35bc86fd5513558"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function checkQuizzes() {
  console.log("Fetching quizzes...");
  try {
    const snap = await getDocs(collection(db, "quizzes"));
    console.log(`Found ${snap.size} quizzes.`);
    snap.forEach(doc => {
      console.log(doc.id, "=>", doc.data().title);
    });
  } catch (error) {
    console.error("Error fetching quizzes:", error);
  }
}

checkQuizzes();
