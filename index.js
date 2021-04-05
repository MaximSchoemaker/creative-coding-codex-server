require('dotenv').config();

// global.atob = require("atob");
// global.Blob = require('node-blob');

const path = require('path');
const util = require('util')
const URL = require('url');
const fs = require('fs');
const express = require('express')
const app = express()

var passport = require('passport');
var GitHubStrategy = require('passport-github').Strategy;

const urlMetadata = require('url-metadata')
const getFavicons = require('get-website-favicon')

var session = require("express-session");
var bodyParser = require('body-parser')
var cors = require('cors');
var https = require('https');

var mongoose = require('mongoose');
var Schema = mongoose.Schema
  , ObjectId = mongoose.Types.ObjectId;

const asyncHandler = require('express-async-handler')
const multer = require("multer");

// var privateKey = fs.readFileSync('sslcert/server.key', 'utf8');
// var certificate = fs.readFileSync('sslcert/server.crt', 'utf8');

fs.rename = util.promisify(fs.rename);

app.use(cors({
  origin: (origin, callback) => {
    callback(null, ["http://127.0.0.1:3000", "http://localhost:3000", "http://192.168.178.21:3000"]);
  },
  credentials: true
}));


app.use(express.static(path.join(__dirname, process.env.BUILD_PATH)));
app.use(express.static("public"));

app.use(bodyParser.json())
app.use(session({
  secret: process.env.SESSION_SECRET, resave: true, saveUninitialized: true,
}));
app.use(passport.initialize());
app.use(passport.session());

const port = 80
const dbUrl = `mongodb://${process.env.MONGODB_USER}:${process.env.MONGODB_PASSWORD}@${process.env.MONGODB_ENDPOINT}/creative-coding-codex?authSource=admin`;
const dbName = 'creative-coding-codex'

const mongooseOptions = {
  useUnifiedTopology: true,
  useNewUrlParser: true,
  useFindAndModify: false
}
console.log(`mongoose.connect`, dbUrl, mongooseOptions)
mongoose.connect(dbUrl, mongooseOptions).then(() => {
  console.log(`mongoose connected!`)
});

const users = mongoose.model('user', new Schema({ _id: ObjectId, username: String, githubId: String, admin: Boolean }));
const resources = mongoose.model('resource', new Schema({
  _id: ObjectId, descriptor: String, url: String, metadata: Object, favicons: Object,
  by: { type: ObjectId, ref: 'user' },
}));
const images = mongoose.model('image', new Schema({
  _id: ObjectId, path: String,
  by: { type: ObjectId, ref: 'user' },
}));
const comments = mongoose.model('comment', new Schema({
  _id: ObjectId, timestamp: Number, text: String, replyTo: new Schema({ type: String, id: String }),
  by: { type: ObjectId, ref: 'user' },
}));
const entries = mongoose.model('entry', new Schema({
  _id: ObjectId, name: String,
  resources: [{ type: ObjectId, ref: 'resource' }],
  images: [{ type: ObjectId, ref: 'image' }],
  comments: [{ type: ObjectId, ref: 'comment' }],
  by: { type: ObjectId, ref: 'user' },
}));

const log = (req, res, next) => {
  console.log();
  console.log(req.method, req.originalUrl);
  if (Object.keys(req.body).length)
    console.log("body", req.body);
  if (Object.keys(req.query).length)
    console.log("query", req.query);
  // if (Object.keys(req.params).length)
  //   console.log("params", req.params);
  next();
}

app.use(log);

const ensureLoggedIn = (req, res, next) => {
  if (!req.user)
    res.status(403).render();
  else
    next();
}
const ensureAdmin = (req, res, next) => {
  if (!req.user || !req.user.admin) {
    console.log(req.user);
    res.status(403).render();
  }
  else
    next();
}

function populate(query) {
  const populateBy = { path: "by", select: { "_id": 1, "username": 1 } };
  return query
    .populate({ path: "by", select: { "_id": 1, "username": 1, "admin": 1 } })
    .populate({ path: "resources", populate: populateBy })
    .populate({ path: "images", populate: populateBy })
    .populate({ path: "comments", populate: populateBy })
}

async function getEntries() {
  return await populate(entries.find())
}

async function getEntry(id) {
  return await populate(entries.findOne({ _id: ObjectId(id) }))
}

passport.use(new GitHubStrategy({
  clientID: process.env.GITHUB_CLIENT_ID,
  clientSecret: process.env.GITHUB_CLIENT_SECRET,
  callbackURL: process.env.PUBLIC_URL + "/auth/github/callback"
},
  async function (accessToken, refreshToken, profile, cb) {
    try {
      const user = await users.findOneAndUpdate(
        { githubId: profile.id },
        { $setOnInsert: { username: profile.displayName || profile.username }, },
        {
          returnOriginal: false,
          upsert: true,
        }
      )
      return cb(null, user);
    } catch (error) {
      console.error(error);
      return cb(error, null);
    };
  }
));

passport.serializeUser(function (user, done) {
  done(null, user._id);
});

passport.deserializeUser(function (id, done) {
  users.findOne({ _id: ObjectId(id) }, function (err, user) {
    done(err, user);
  });
});

const storeRedirectToInSession = (req, res, next) => {
  req.session.redirectTo = req.get("referer") || process.env.FRONTEND_PUBLIC_URL;
  console.log("redirectTo", req.session.redirectTo);
  next();
};


app.get('/auth/github',
  storeRedirectToInSession,
  passport.authenticate('github'),
);

app.get('/auth/github/callback',
  passport.authenticate('github', { failureRedirect: process.env.FRONTEND_PUBLIC_URL, failureFlash: true }),
  function (req, res) {
    console.log("authenticated", req.user);
    res.redirect(req.session.redirectTo || process.env.FRONTEND_PUBLIC_URL);
  });

app.get('/logout',
  storeRedirectToInSession,
  (req, res) => {
    req.logout();
    res.redirect(req.session.redirectTo);
  }
);

app.get('/user', function (req, res) {
  res.send({ user: req.user || null });
});


app.get('/entries',
  asyncHandler(async (req, res) => {
    res.send(await getEntries());
  })
)

app.post('/entries',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    await entries.create({ _id: new ObjectId(), name: req.body.name, by: req.user._id })
    res.send(await getEntries());
  })
)

app.put('/entries/:entryId',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const { entryId } = req.params;
    await entries.updateOne({ _id: ObjectId(entryId) }, { $set: req.body })
    res.send(await getEntries());
  })
)

app.delete('/entries/:entryId',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const { entryId } = req.params;
    await entries.deleteOne({ _id: ObjectId(entryId) })
    res.send(await getEntries());
  })
)

app.post('/entries/:entryId/comment',
  ensureLoggedIn,
  asyncHandler(async (req, res) => {
    const { entryId } = req.params;
    const { timestamp, text, replyTo } = req.body;

    const comment = await comments.create({ _id: ObjectId(), by: ObjectId(req.user._id), timestamp, text, replyTo });

    await entries.updateOne(
      { _id: ObjectId(entryId) },
      { $addToSet: { comments: ObjectId(comment._id) }, }
    )

    res.send(await getEntry(entryId));
  })
)

app.delete('/entries/:entryId/comment/:commentId',
  ensureLoggedIn,
  asyncHandler(async (req, res) => {
    const { entryId, commentId } = req.params;

    await comments.deleteOne({ _id: ObjectId(commentId) })

    await entries.updateOne(
      { _id: ObjectId(entryId) },
      { $pull: { comments: ObjectId(commentId) } }
    )

    res.send(await getEntry(entryId));
  })
)

app.post('/entries/:entryId/resource',
  ensureLoggedIn,
  asyncHandler(async (req, res) => {
    const { entryId, commentId } = req.params;
    const { descriptor, url: urlString } = req.body;


    const url = URL.parse(urlString);
    if (!url.protocol)
      url.href = "http://" + url.href;

    console.log(url);
    const metadata = await urlMetadata(url.href)
    const favicons = await getFavicons(url.href);
    console.log(favicons);
    const resource = await resources.create({ _id: ObjectId(), by: req.user._id, descriptor, url: url.href, metadata, favicons });

    await entries.updateOne(
      { _id: ObjectId(entryId) },
      { $addToSet: { resources: ObjectId(resource._id) } }
    )

    res.send(await getEntry(entryId));
  })
)



const upload = multer({
  dest: "/temp",
  limits: {
    fileSize: 1100000,
  },
});

app.post(
  "/entries/:entryId/image",
  storeRedirectToInSession,
  upload.single("file" /* name attribute of <file> element in your form */),
  asyncHandler(async (req, res) => {
    const { entryId } = req.params;

    if (!req.user) {
      res.redirect(req.session.redirectTo);
      return;
    }

    const { path: tempPath, originalname } = req.file;

    const targetPath = path.join(__dirname, "public/");
    const targetFolder = "uploads/" + req.user._id + "/";
    const targetFile = "image";
    const targetExt = path.extname(originalname);

    let fileName = targetFile;
    let i = 1;
    while (fs.existsSync(targetPath + targetFolder + fileName + targetExt)) {
      i++
      fileName = "image_" + i;
    }
    const target = targetPath + targetFolder + fileName + targetExt;

    if (!fs.existsSync(targetPath + targetFolder))
      fs.mkdirSync(targetPath + targetFolder);

    await fs.rename(tempPath, target);

    const image = await images.create({
      _id: new ObjectId(),
      by: ObjectId(req.user._id),
      path: targetFolder + fileName + targetExt
    });
    console.log(image);

    await entries.updateOne(
      { _id: ObjectId(entryId) },
      { $addToSet: { images: ObjectId(image._id) } },
    )

    res.send(await getEntry(entryId));
  })
);


app.get('*', (req, res) => {
  const dir = path.join(__dirname, process.env.BUILD_PATH, 'index.html');
  res.sendFile(dir)
})

app.listen(port, () => {
  console.log(`listening at http://localhost:${port}`)
})


