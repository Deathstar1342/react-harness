import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';
function Counter(){const [count,setCount]=useState(0);return <main><p>CONTROLLED PROJECT FIXTURE</p><h1>Owned project preview</h1><p>React modules and relative CSS load through the bounded owned-server transport.</p><button id="counter" onClick={()=>setCount(count+1)}>Count {count}</button></main>;}
createRoot(document.getElementById('root')!).render(<Counter/>);
