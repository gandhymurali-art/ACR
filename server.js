const express = require("express");
const { crawl } = require("./script");

const app = express();

app.use(express.json());

// Health Check
app.get("/", (req, res) => {
    res.json({
        success: true,
        service: "Land Crawler",
        status: "Running"
    });
});

app.get("/health", (req, res) => {
    res.json({
        success: true,
        status: "UP"
    });
});

// Crawl API
app.post("/crawl", async (req, res) => {
    try {

        console.log("==================================");
        console.log("New Crawl Request");
        console.log(req.body);
        console.log("==================================");

        const result = await crawl(req.body);

        res.status(200).json({
            success: true,
            data: result
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: err.message
        });

    }

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Crawler API listening on port ${PORT}`);
});