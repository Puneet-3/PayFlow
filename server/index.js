require("dotenv").config();
const mongoose = require("mongoose");

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("db connected"))
    .catch((err) => console.log(err));



//bring the library to work
const express = require('express');


//create a app
const app = express();

// when someone visit '/health' they get 'ok'
app.get('/health', (req, res) => {
    res.send("ok");
});

app.get('/hello/:name', (req, res) => {
    res.json({
        "message": "hello " + req.params.name,
        "status": "ok"
    })
});

//start the server
app.listen(5000, () => {
    console.log("server is running")
});