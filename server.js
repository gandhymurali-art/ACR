const express = require("express");
const { crawl } = require("./script");
const { crawlUsingPPNumber } = require("./pattadarPassbookScript");

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

// Crawl Using Survey and Khata Number API
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

// Crawl Using Pattadar Passbook Number API
app.post("/getDetailsUsingPPNumber", async (req, res) => {
    try {

        console.log("==================================");
        console.log("New getDetailsUsingPPNumber Request");
        console.log(req.body);
        console.log("==================================");

        const result = await crawlUsingPPNumber(req.body);

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