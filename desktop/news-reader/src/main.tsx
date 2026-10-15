import React from "react"
import ReactDOM from "react-dom/client"

import { NewsReader } from "./NewsReader"
import "./styles.css"

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <NewsReader />
  </React.StrictMode>,
)
