require('dotenv').config();

const path = require('path');
const url = require('url');
const fs = require('fs');
const express = require('express')
const app = express()

var passport = require('passport');
var GitHubStrategy = require('passport-github').Strategy;

const urlMetadata = require('url-metadata')

var session = require("express-session");
var bodyParser = require('body-parser')
var cors = require('cors');

const { MongoClient, ObjectId } = require('mongodb');

const PUBLIC_URL = "http://188.226.142.229:3001";
const FRONTEND_PUBLIC_URL = "http://maximschoemaker.com/creative-coding-codex";

// const PUBLIC_URL = "http://localhost:3001";
// const FRONTEND_PUBLIC_URL = "http://localhost:3000/";

app.use(cors({
  origin: (origin, callback) => {
    callback(null, ["http://maximschoemaker.com", "http://127.0.0.1:3000", "http://localhost:3000", "http://192.168.178.21:3000"]);
  },

  credentials: true
}));

app.use(express.static("public"));
app.use(session({ secret: process.env.SESSION_SECRET, resave: true, saveUninitialized: true }));
app.use(bodyParser.json())
app.use(passport.initialize());
app.use(passport.session());


const port = 3001


const dbUrl = `mongodb://${process.env.MONGODB_USER}:${process.env.MONGODB_PASSWORD}@188.226.142.229:27017`;
const dbName = 'creative-coding-codex'
let db;
MongoClient.connect(dbUrl, { useUnifiedTopology: true }, (err, client) => {
  if (err) return console.error(err)
  console.log('Connected to Database')

  db = client.db(dbName)
  console.log(`Connected MongoDB: ${dbUrl}`)
  console.log(`Database: ${dbName}`)


  const users = db.collection('users')

  passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: PUBLIC_URL + "/auth/github/callback"
  },
    function (accessToken, refreshToken, profile, cb) {
      users.findOneAndUpdate(
        { githubId: profile.id },
        { $setOnInsert: { username: profile.displayName || profile.username }, },
        {
          returnOriginal: false,
          upsert: true,
        }
      )
        .then((user) => {
          console.log("github strategy", user);
          return cb(err, user.value);
        }).catch(error => {
          console.error(error);
        });
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
    req.session.redirectTo = req.get("referer") || FRONTEND_PUBLIC_URL;
    console.log("redirectTo", req.session.redirectTo);
    next();
  };

  app.get('/auth/github',
    storeRedirectToInSession,
    passport.authenticate('github'),
  );

  app.get('/auth/github/callback',
    passport.authenticate('github', { failureRedirect: FRONTEND_PUBLIC_URL, failureFlash: true }),
    function (req, res) {
      console.log("authenticated", req.user);
      // console.log(req.headers);
      // Successful authentication, redirect home.
      res.redirect(req.session.redirectTo);
    });

  app.get('/logout', function (req, res) {
    req.logout();
    const redirectTo = req.get("referer") || FRONTEND_PUBLIC_URL;
    res.redirect(redirectTo);
  });

  app.get('/user', function (req, res) {
    console.log("/user", req.user);
    res.send({ user: req.user || null });
  });

  const ensureLoggedIn = (req, res, next) => {
    if (!req.user)
      res.status(403).render();
    else
      next();
  }
  const ensureAdmin = (req, res, next) => {
    if (!req.user || !req.user.admin)
      res.status(403).render();
    else
      next();
  }

  const entries = db.collection('entries')

  app.get('/entries',
    // ensureLoggedIn,
    (req, res) => {
      entries.find().toArray()
        .then(results => {
          res.send(results);
        })
        .catch(error => console.error(error))
    })

  const constructNewEntry = (req, res, next) => {
    let { name, resources, images, comments } = req.body;

    // resources = resources.map(({ descriptor, url }) => ({ descriptor, url }));
    // images = images.map(({ path }) => ({ path }));
    // comments = comments.map(({ by, timestamp, text, replyTo }) => ({ by, timestamp, text, replyTo }));

    req.newEntry = { name, resources, images, comments };
    if (name && resources.every(l => l.descriptor && l.url))
      next();
    else
      res.status(400).render();
  }

  app.post('/entries/new',
    ensureAdmin,
    constructNewEntry,
    (req, res) => {
      entries.insertOne(req.newEntry).then(results => {
        entries.find().toArray()
          .then(results => {
            // console.log(results)
            res.send(results);
          })
          .catch(error => console.error(error))
      });
    })

  app.post('/entries/update',
    ensureAdmin,
    constructNewEntry,
    (req, res) => {
      entries.updateOne({ _id: ObjectId(req.body._id) }, { $set: req.newEntry }).then(results => {
        entries.find().toArray()
          .then(results => {
            res.send(results);
          })
          .catch(error => console.error(error))
      });
    })

  app.post('/entries/remove',
    ensureAdmin,
    (req, res) => {
      entries.removeOne({ _id: ObjectId(req.body._id) }).then(results => {
        entries.find().toArray()
          .then(results => {
            res.send(results);
          })
          .catch(error => console.error(error))
      });
    })

  app.post('/entries/:id/comment',
    ensureLoggedIn,
    (req, res) => {
      // console.log(req.params);

      const { timestamp, text, replyTo } = req.body;
      const comment = { _id: ObjectId(), by: req.user, timestamp, text, replyTo };
      console.log(req.body);
      console.log(comment);
      entries.updateOne(
        { _id: ObjectId(req.params.id) },
        { $addToSet: { comments: comment }, }
      )
        .then(results => {

          entries.findOne({ _id: ObjectId(req.params.id) }).then(results => {
            res.send(results);
          });

        }).catch(error => {
          console.error(error);
          res.status(400).end();
        });
    })

  app.delete('/entries/:id/comment/:commentId',
    ensureLoggedIn,
    (req, res) => {
      console.log(req.params);

      entries.updateOne(
        { _id: ObjectId(req.params.id) },
        { $pull: { comments: { _id: ObjectId(req.params.commentId) } } }
      )
        .then(results => {

          entries.findOne({ _id: ObjectId(req.params.id) }).then(results => {
            res.send(results);
          });

        }).catch(error => {
          console.error(error);
          res.status(400).end();
        });
    })

  app.post('/entries/:id/resource',
    ensureLoggedIn,
    (req, res) => {
      // console.log(req.params);

      const { descriptor, url } = req.body;
      const resource = { _id: ObjectId(), by: req.user, descriptor, url, };

      urlMetadata(url).then(
        function (metadata) {
          console.log(metadata)

          resource.metadata = metadata;

          return entries.updateOne(
            { _id: ObjectId(req.params.id) },
            { $addToSet: { resources: resource }, }
          )
            .then(results => {

              entries.findOne({ _id: ObjectId(req.params.id) }).then(results => {
                res.send(results);
              });

            }).catch(error => {
              console.error(error);
              res.status(400).end();
            });
        },
        function (error) {
          console.log(error)
        })


    })

  const multer = require("multer");

  const handleError = (err, res) => {
    res
      .status(500)
      .contentType("text/plain")
      .end("Oops! Something went wrong!");
  };

  const upload = multer({
    dest: "/temp"
    // you might also want to set some limits: https://github.com/expressjs/multer#limits
  });


  app.post(
    "/upload",
    storeRedirectToInSession,
    upload.single("file" /* name attribute of <file> element in your form */),
    (req, res) => {
      const tempPath = req.file.path;

      const targetPath = path.join(__dirname, "./uploads/");
      const targetFile = "image";
      const targetExt = path.extname(req.file.originalname);

      let file = targetFile;
      let i = 1;
      while (fs.existsSync(targetPath + file + targetExt)) {
        i++
        file = "image_" + i;
      }
      const target = targetPath + file + targetExt;

      // if (path.extname(req.file.originalname).toLowerCase() === ".png") {
      fs.rename(tempPath, target, err => {
        if (err) return handleError(err, res);

        entries.updateOne(
          { _id: ObjectId(req.query._id) },
          { $addToSet: { images: { path: file + targetExt } } }
        )
          .then(results => {
            res.redirect(req.session.redirectTo);
          });
      });
      // } else {
      //   fs.unlink(tempPath, err => {
      //     if (err) return handleError(err, res);

      //     res
      //       .status(403)
      //       .contentType("text/plain")
      //       .end("Only .png files are allowed!");
      //   });
      // }
    }
  );

  var mime = {
    html: 'text/html',
    txt: 'text/plain',
    css: 'text/css',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    js: 'application/javascript'
  };


  var dir = path.join(__dirname, 'uploads');
  app.get('*', function (req, res) {
    var file = path.join(dir, req.path.replace(/\/$/, '/index.html'));
    if (file.indexOf(dir + path.sep) !== 0) {
      return res.status(403).end('Forbidden');
    }
    var type = mime[path.extname(file).slice(1)] || 'text/plain';
    var s = fs.createReadStream(file);
    s.on('open', function () {
      res.set('Content-Type', type);
      s.pipe(res);
    });
    s.on('error', function () {
      res.set('Content-Type', 'text/plain');
      res.status(404).end('Not found');
    });
  });

  app.listen(port, () => {
    console.log(`listening at http://localhost:${port}`)
  })
})

